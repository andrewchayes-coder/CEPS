import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidPaymentMonth(value: string): boolean {
  return value === '' || MONTH_PATTERN.test(value);
}

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  label?: string | null;
};

export function MonthYearInput({ id, value, onChange, disabled, required, label = 'Payment Month' }: Props) {
  const invalid = !isValidPaymentMonth(value);
  return (
    <div className="space-y-2">
      {label !== null && <Label htmlFor={id}>{label}</Label>}
      <Input
        id={id}
        type="month"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : undefined}
        required={required}
        disabled={disabled}
        data-testid="input-payment-month"
      />
      {invalid && (
        <p id={`${id}-error`} className="text-sm text-destructive" role="alert">
          Enter a valid month in YYYY-MM format.
        </p>
      )}
    </div>
  );
}