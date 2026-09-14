// A minimal Borsh codec driven by the IDL, on Uint8Array and DataView.
//
// Layouts are READ from the IDL types rather than written as offsets. Nuvem's
// hand-written policy decoder read the leg count at byte 73; SIP's program
// inserted in_mint before the legs and the count moved to 105. A codec that
// walks the IDL moves with the program; a table of offsets silently misreads.
//
// DELIBERATELY SMALL. The types the sip_vault IDL uses are supported; anything
// else (enums, options, strings, signed 128-bit) THROWS, so a future IDL change
// fails the tests instead of decoding garbage. Field names are the IDL's
// (snake_case); decoders.ts maps them for callers.
//
// Integers: u8/u16/u32 are numbers; u64/i64/u128 are bigints. Public keys are
// base58 strings. Nothing here needs the web3 SDK or Node.

import { base58Encode, tryBase58Decode } from "./base58";
import { IDL_VEC_MAX_LEN, idlInstruction, idlTypeDef, type IdlField, type IdlType } from "./idl";

export class BorshError extends Error {
  override readonly name = "BorshError";
}

const FIXED: Readonly<Record<string, number>> = { bool: 1, u8: 1, u16: 2, u32: 4, u64: 8, i64: 8, u128: 16, pubkey: 32 };

/** Where in a struct a value sits, so vec bounds and error messages can name it. */
interface Site {
  readonly struct: string | null;
  readonly field: string;
}

const describe = (site: Site): string => (site.struct === null ? site.field : `${site.struct}.${site.field}`);

const vecMax = (site: Site): number | null =>
  site.struct === null ? null : (IDL_VEC_MAX_LEN[site.struct]?.[site.field] ?? null);

function structFields(name: string): readonly IdlField[] {
  const def = idlTypeDef(name);
  if (def.type.kind !== "struct" || def.type.fields === undefined) {
    throw new BorshError(`IDL type ${name} is a ${def.type.kind}, and this codec only handles structs`);
  }
  return def.type.fields;
}

// ── decoding ─────────────────────────────────────────────────────────────────

export interface Decoded<T> {
  readonly value: T;
  /** The offset just past the decoded value. */
  readonly end: number;
}

function need(bytes: Uint8Array, offset: number, size: number, site: Site): void {
  if (offset < 0 || offset + size > bytes.length) {
    throw new BorshError(`${describe(site)}: needs ${size} bytes at offset ${offset}, only ${bytes.length - offset} remain`);
  }
}

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function readU128(dv: DataView, offset: number): bigint {
  return dv.getBigUint64(offset, true) + (dv.getBigUint64(offset + 8, true) << 64n);
}

export function decodeType(type: IdlType, bytes: Uint8Array, offset: number, site: Site = { struct: null, field: "value" }): Decoded<unknown> {
  if (typeof type === "string") {
    const size = FIXED[type];
    if (size === undefined && type !== "bytes") throw new BorshError(`${describe(site)}: unsupported IDL type ${type}`);
    const dv = view(bytes);
    switch (type) {
      case "bool": {
        need(bytes, offset, 1, site);
        const byte = bytes[offset]!;
        if (byte > 1) throw new BorshError(`${describe(site)}: a bool must be 0 or 1, found ${byte}`);
        return { value: byte === 1, end: offset + 1 };
      }
      case "u8":
        need(bytes, offset, 1, site);
        return { value: bytes[offset]!, end: offset + 1 };
      case "u16":
        need(bytes, offset, 2, site);
        return { value: dv.getUint16(offset, true), end: offset + 2 };
      case "u32":
        need(bytes, offset, 4, site);
        return { value: dv.getUint32(offset, true), end: offset + 4 };
      case "u64":
        need(bytes, offset, 8, site);
        return { value: dv.getBigUint64(offset, true), end: offset + 8 };
      case "i64":
        need(bytes, offset, 8, site);
        return { value: dv.getBigInt64(offset, true), end: offset + 8 };
      case "u128":
        need(bytes, offset, 16, site);
        return { value: readU128(dv, offset), end: offset + 16 };
      case "pubkey":
        need(bytes, offset, 32, site);
        return { value: base58Encode(bytes.subarray(offset, offset + 32)), end: offset + 32 };
      case "bytes": {
        need(bytes, offset, 4, site);
        const length = dv.getUint32(offset, true);
        need(bytes, offset + 4, length, site);
        return { value: bytes.slice(offset + 4, offset + 4 + length), end: offset + 4 + length };
      }
    }
    throw new BorshError(`${describe(site)}: unsupported IDL type ${type}`);
  }
  if ("array" in type) {
    const [inner, count] = type.array;
    const out: unknown[] = [];
    let at = offset;
    for (let i = 0; i < count; i++) {
      const decoded = decodeType(inner, bytes, at, site);
      out.push(decoded.value);
      at = decoded.end;
    }
    return { value: out, end: at };
  }
  if ("vec" in type) {
    need(bytes, offset, 4, site);
    const length = view(bytes).getUint32(offset, true);
    const max = vecMax(site);
    if (max !== null && length > max) {
      throw new BorshError(`${describe(site)}: holds ${length} entries; the program caps it at ${max}`);
    }
    // Every element is at least one byte, so a length the remaining bytes
    // cannot hold is refused before anything is allocated.
    if (length > bytes.length - offset - 4) {
      throw new BorshError(`${describe(site)}: claims ${length} entries in ${bytes.length - offset - 4} bytes`);
    }
    const out: unknown[] = [];
    let at = offset + 4;
    for (let i = 0; i < length; i++) {
      const decoded = decodeType(type.vec, bytes, at, site);
      out.push(decoded.value);
      at = decoded.end;
    }
    return { value: out, end: at };
  }
  if ("defined" in type) return decodeStruct(type.defined.name, bytes, offset);
  throw new BorshError(`${describe(site)}: unsupported IDL type ${JSON.stringify(type)}`);
}

export function decodeStruct(typeName: string, bytes: Uint8Array, offset = 0): Decoded<Record<string, unknown>> {
  const value: Record<string, unknown> = {};
  let at = offset;
  for (const field of structFields(typeName)) {
    const decoded = decodeType(field.type, bytes, at, { struct: typeName, field: field.name });
    value[field.name] = decoded.value;
    at = decoded.end;
  }
  return { value, end: at };
}

/** An instruction's arguments. The discriminator must match and every byte must be consumed. */
export function decodeArgs(instructionName: string, data: Uint8Array): Record<string, unknown> {
  const instruction = idlInstruction(instructionName);
  if (data.length < 8 || !instruction.discriminator.every((byte, i) => data[i] === byte)) {
    throw new BorshError(`${instructionName}: the data does not start with its discriminator`);
  }
  const value: Record<string, unknown> = {};
  let at = 8;
  for (const arg of instruction.args) {
    const decoded = decodeType(arg.type, data, at, { struct: null, field: `${instructionName}(${arg.name})` });
    value[arg.name] = decoded.value;
    at = decoded.end;
  }
  if (at !== data.length) throw new BorshError(`${instructionName}: ${data.length - at} trailing bytes after the arguments`);
  return value;
}

// ── encoding ─────────────────────────────────────────────────────────────────

class Writer {
  #chunks: Uint8Array[] = [];
  #length = 0;

  push(bytes: Uint8Array): void {
    this.#chunks.push(bytes);
    this.#length += bytes.length;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

function littleEndian(value: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let rest = value;
  for (let i = 0; i < size; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function pubkeyBytes(value: unknown, site: Site): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== 32) throw new BorshError(`${describe(site)}: a public key is 32 bytes, got ${value.length}`);
    return value;
  }
  if (typeof value === "string") {
    const decoded = tryBase58Decode(value);
    if (decoded === null || decoded.length !== 32) throw new BorshError(`${describe(site)}: not a base58 32-byte public key`);
    return decoded;
  }
  if (value !== null && typeof value === "object" && typeof (value as { toBytes?: unknown }).toBytes === "function") {
    return pubkeyBytes((value as { toBytes: () => Uint8Array }).toBytes(), site);
  }
  throw new BorshError(`${describe(site)}: expected a public key`);
}

function unsignedNumber(value: unknown, max: number, site: Site, type: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new BorshError(`${describe(site)}: expected an integer ${type} (0..${max})`);
  }
  return value;
}

function bigintIn(value: unknown, min: bigint, max: bigint, site: Site, type: string): bigint {
  if (typeof value !== "bigint" || value < min || value > max) {
    throw new BorshError(`${describe(site)}: expected a bigint ${type} (${min}..${max})`);
  }
  return value;
}

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

function encodeType(type: IdlType, value: unknown, writer: Writer, site: Site): void {
  if (typeof type === "string") {
    switch (type) {
      case "bool":
        if (typeof value !== "boolean") throw new BorshError(`${describe(site)}: expected a boolean`);
        writer.push(Uint8Array.of(value ? 1 : 0));
        return;
      case "u8":
        writer.push(Uint8Array.of(unsignedNumber(value, 0xff, site, type)));
        return;
      case "u16": {
        const n = unsignedNumber(value, 0xffff, site, type);
        writer.push(Uint8Array.of(n & 0xff, n >> 8));
        return;
      }
      case "u32":
        writer.push(littleEndian(BigInt(unsignedNumber(value, 0xffff_ffff, site, type)), 4));
        return;
      case "u64":
        writer.push(littleEndian(bigintIn(value, 0n, U64_MAX, site, type), 8));
        return;
      case "i64": {
        const n = bigintIn(value, -(1n << 63n), (1n << 63n) - 1n, site, type);
        writer.push(littleEndian(BigInt.asUintN(64, n), 8));
        return;
      }
      case "u128":
        writer.push(littleEndian(bigintIn(value, 0n, U128_MAX, site, type), 16));
        return;
      case "pubkey":
        writer.push(pubkeyBytes(value, site));
        return;
      case "bytes":
        if (!(value instanceof Uint8Array)) throw new BorshError(`${describe(site)}: expected bytes`);
        writer.push(littleEndian(BigInt(value.length), 4));
        writer.push(value);
        return;
    }
    throw new BorshError(`${describe(site)}: unsupported IDL type ${type}`);
  }
  if ("array" in type) {
    const [inner, count] = type.array;
    if (!Array.isArray(value) || value.length !== count) throw new BorshError(`${describe(site)}: expected an array of ${count}`);
    for (const item of value) encodeType(inner, item, writer, site);
    return;
  }
  if ("vec" in type) {
    if (!Array.isArray(value)) throw new BorshError(`${describe(site)}: expected an array`);
    const max = vecMax(site);
    if (max !== null && value.length > max) throw new BorshError(`${describe(site)}: at most ${max} entries, got ${value.length}`);
    writer.push(littleEndian(BigInt(value.length), 4));
    for (const item of value) encodeType(type.vec, item, writer, site);
    return;
  }
  if ("defined" in type) {
    encodeStructInto(type.defined.name, value, writer);
    return;
  }
  throw new BorshError(`${describe(site)}: unsupported IDL type ${JSON.stringify(type)}`);
}

function encodeFields(owner: string, fields: readonly IdlField[], value: unknown, writer: Writer, structName: string | null): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BorshError(`${owner}: expected an object`);
  const record = value as Record<string, unknown>;
  const known = new Set(fields.map((field) => field.name));
  const extra = Object.keys(record).filter((key) => !known.has(key));
  // STRICT BOTH WAYS. A camelCased key (maxRolling30d) next to a missing
  // snake_case one is the exact mistake that crashed the keeper; say so.
  if (extra.length > 0) throw new BorshError(`${owner}: unknown field(s) ${extra.join(", ")}; the IDL names are ${[...known].join(", ")}`);
  for (const field of fields) {
    if (!(field.name in record)) throw new BorshError(`${owner}: missing field ${field.name}`);
    encodeType(field.type, record[field.name], writer, { struct: structName, field: structName === null ? `${owner}(${field.name})` : field.name });
  }
}

function encodeStructInto(typeName: string, value: unknown, writer: Writer): void {
  encodeFields(typeName, structFields(typeName), value, writer, typeName);
}

/** A struct's Borsh bytes (no discriminator). Used by tests and fixtures, and exact for any account body. */
export function encodeStruct(typeName: string, value: Record<string, unknown>): Uint8Array {
  const writer = new Writer();
  encodeStructInto(typeName, value, writer);
  return writer.bytes();
}

/** Instruction data: the IDL discriminator, then every argument in IDL order. */
export function encodeArgs(instructionName: string, args: Record<string, unknown>): Uint8Array {
  const instruction = idlInstruction(instructionName);
  const writer = new Writer();
  writer.push(Uint8Array.from(instruction.discriminator));
  encodeFields(instructionName, instruction.args, args, writer, null);
  return writer.bytes();
}

// ── sizes ────────────────────────────────────────────────────────────────────

/** The most bytes a value of `type` can occupy, with vectors at their IDL_VEC_MAX_LEN bound. */
export function typeMaxSize(type: IdlType, site: Site = { struct: null, field: "value" }): number {
  if (typeof type === "string") {
    const size = FIXED[type];
    if (size === undefined) throw new BorshError(`${describe(site)}: ${type} has no bounded size`);
    return size;
  }
  if ("array" in type) return typeMaxSize(type.array[0], site) * type.array[1];
  if ("vec" in type) {
    const max = vecMax(site);
    if (max === null) throw new BorshError(`${describe(site)}: an unbounded vec has no size; add it to IDL_VEC_MAX_LEN`);
    return 4 + max * typeMaxSize(type.vec, site);
  }
  if ("defined" in type) return structMaxSize(type.defined.name);
  throw new BorshError(`${describe(site)}: unsupported IDL type ${JSON.stringify(type)}`);
}

export function structMaxSize(typeName: string): number {
  return structFields(typeName).reduce((sum, field) => sum + typeMaxSize(field.type, { struct: typeName, field: field.name }), 0);
}

/** The space Anchor allocates for an account: its 8-byte discriminator plus the struct at its maximum. */
export const accountSpace = (accountName: string): number => 8 + structMaxSize(accountName);

/**
 * Where a field starts inside a struct, when every field before it is fixed-size
 * (throws otherwise, because after a vec the offset depends on the data).
 */
export function fieldOffset(typeName: string, fieldName: string): number {
  let at = 0;
  for (const field of structFields(typeName)) {
    if (field.name === fieldName) return at;
    const type = field.type;
    if (typeof type !== "string" && "vec" in type) {
      throw new BorshError(`${typeName}.${fieldName} follows the vec ${field.name}, so it has no fixed offset`);
    }
    at += typeMaxSize(type, { struct: typeName, field: field.name });
  }
  throw new BorshError(`IDL type ${typeName} has no field ${fieldName}`);
}
