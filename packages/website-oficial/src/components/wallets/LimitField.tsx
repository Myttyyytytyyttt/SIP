/**
 * One of the vault's two limits, as a SOL field. Shared by the vault card's
 * forms and the new-user setup, so the three look and read the same.
 */

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LimitField({
  id,
  label,
  value,
  onChange,
  disabled,
  hint,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly hint: string | null;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} inputMode="decimal" autoComplete="off" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="font-mono" />
        <span className="text-sm text-muted-foreground">SOL</span>
      </div>
      {hint !== null ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
