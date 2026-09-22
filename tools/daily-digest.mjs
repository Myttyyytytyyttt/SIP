#!/usr/bin/env node
// WHAT ACTUALLY HAPPENED TODAY, gathered without asking a model to remember.
//
// The daily changelog routine needs facts, not recollection: the commits that
// landed, and what the owner actually asked for across every Claude session on
// this project. Both are on disk. This prints them as one markdown digest, so
// the writing step starts from evidence instead of from a summary of a summary.
//
//   node tools/daily-digest.mjs            # today
//   node tools/daily-digest.mjs 2026-09-21 # a given day, local time
//
// Sessions live OUTSIDE the repo, in ~/.claude/projects/<slug>/*.jsonl, one JSON
// object per line. They are large — tens of megabytes each — so every file is
// streamed and only the owner's own messages are kept. Tool results, assistant
// turns and system reminders are noise for a changelog and would bury the signal.
// That is also why this cannot run anywhere but the machine the chats live on.

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Claude stores a project's sessions under a slug of its absolute path. */
const SESSIONS = join(homedir(), ".claude", "projects", REPO.replace(/\//g, "-"));
/** A separator no commit message will contain, so --pretty output can be split safely. */
const SEP = "<<|FIELD|>>";
const END = "<<|COMMIT|>>";

const day = process.argv[2] ?? new Date().toLocaleDateString("sv-SE"); // sv-SE is YYYY-MM-DD, local
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error(`Not a date: ${day}. Use YYYY-MM-DD.`);
  process.exit(1);
}

const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trimEnd();
const out = [];
out.push(`# Digest for ${day}`, "");

// ─────────────────────────── what landed ───────────────────────────
// Commits are the hard evidence: a changelog entry not backed by one is a plan,
// not a change.
const range = [`--since=${day} 00:00`, `--until=${day} 23:59:59`];
const log = git(["log", ...range, `--pretty=format:%H${SEP}%an${SEP}%aI${SEP}%s${SEP}%b${END}`]);
const commits = log === "" ? [] : log.split(END).map((c) => c.trim()).filter((c) => c !== "");

out.push(`## Commits (${commits.length})`, "");
if (commits.length === 0) out.push("_Nothing landed on this day._", "");
for (const entry of commits) {
  const [hash, author, iso, subject, body] = entry.split(SEP);
  const files = git(["show", "--stat", "--format=", hash]).split("\n").filter((l) => l.trim() !== "");
  out.push(`### \`${hash.slice(0, 7)}\` ${subject}`);
  out.push(`*${iso.slice(11, 16)} · ${author}*`, "");
  if (body && body.trim() !== "") out.push(body.trim(), "");
  out.push("```", ...files, "```", "");
}

// ─────────────────────── what was asked for ────────────────────────
// The owner's own words. Decisions, reversals and new requests live here and
// nowhere else: a commit says what changed, never why it was wanted.
out.push("## What the owner asked for", "");
if (!existsSync(SESSIONS)) {
  out.push(`_No session directory at ${SESSIONS}._`, "");
} else {
  const files = readdirSync(SESSIONS).filter((f) => f.endsWith(".jsonl"));
  const bySession = new Map();

  for (const file of files) {
    const stream = createInterface({ input: createReadStream(join(SESSIONS, file)), crlfDelay: Infinity });
    for await (const line of stream) {
      // Cheap gate first: JSON.parse on every line of tens of megabytes is the slow path.
      if (!line.includes('"type":"user"') || !line.includes(day)) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== "user") continue;
      if (!(entry.timestamp || "").startsWith(day)) continue;

      const content = entry.message && entry.message.content;
      const parts =
        typeof content === "string"
          ? [content]
          : Array.isArray(content)
            ? content.filter((p) => p && p.type === "text").map((p) => p.text || "")
            : [];
      for (const raw of parts) {
        const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        // Slash commands and the harness's own caveats are not the owner speaking.
        if (text === "" || text.startsWith("<command-") || text.startsWith("Caveat:")) continue;
        const key = file.slice(0, 8);
        const list = bySession.get(key) || [];
        list.push({ at: entry.timestamp.slice(11, 16), text: text.length > 1200 ? `${text.slice(0, 1200)} …[trimmed]` : text });
        bySession.set(key, list);
      }
    }
  }

  if (bySession.size === 0) out.push("_No sessions were active on this day._", "");
  for (const [session, messages] of [...bySession].sort()) {
    out.push(`### session \`${session}\` — ${messages.length} message(s)`, "");
    for (const m of messages) out.push(`- **${m.at}** ${m.text.replace(/\n+/g, "\n  ")}`);
    out.push("");
  }
}

// ───────────────────────── where it stands ─────────────────────────
// Several Claude sessions share this one working tree, so a digest that does not
// say whether the tree is dirty invites a routine to commit someone else's
// half-finished work.
out.push("## Repository state at digest time", "");
out.push("```");
out.push(`branch: ${git(["rev-parse", "--abbrev-ref", "HEAD"])}`);
out.push(`head:   ${git(["log", "-1", "--pretty=format:%h %s"])}`);
const dirty = git(["status", "--short"]);
out.push(`tree:   ${dirty === "" ? "clean" : `${dirty.split("\n").length} path(s) uncommitted — another session may be mid-work`}`);
if (dirty !== "") out.push(dirty);
out.push("```", "");

console.log(out.join("\n"));
