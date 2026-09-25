import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PREFERRED_LANGUAGE_OPTIONS, languageChoice } from '@/lib/preferred-language';

type Props = {
  value: string;
  onChange: (value: string, otherSelected: boolean) => void;
  error?: string;
  required?: boolean;
};

/** Stores the actual language, never the UI-only "Other" sentinel. */
export function PreferredLanguageField({ value, onChange, error, required = false }: Props) {
  const [choice, setChoice] = useState(() => languageChoice(value));
  const errorId = 'preferred-language-error';
  return (
    <div className="space-y-2">
      <Label htmlFor="preferred-language-select">Preferred Language{required ? ' *' : ''}</Label>
      <Select value={choice} onValueChange={(next) => {
        setChoice(next);
        onChange(next === 'Other' ? '' : next, next === 'Other');
      }}>
        <SelectTrigger id="preferred-language-select" data-testid="select-preferred-language" aria-invalid={!!error} aria-describedby={error ? errorId : undefined}>
          <SelectValue placeholder="Select a language" />
        </SelectTrigger>
        <SelectContent>
          {PREFERRED_LANGUAGE_OPTIONS.map((option) => <SelectItem value={option} key={option}>{option}</SelectItem>)}
        </SelectContent>
      </Select>
      {choice === 'Other' && (
        <div className="space-y-2">
          <Label htmlFor="preferred-language-other">Specify language *</Label>
          <Input
            id="preferred-language-other"
            data-testid="input-preferred-language-other"
            value={value}
            onChange={(event) => onChange(event.target.value, true)}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
      )}
      {error && <p id={errorId} role="alert" className="text-sm font-medium text-destructive">{error}</p>}
    </div>
  );
}