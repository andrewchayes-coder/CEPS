import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DateRangeFilter } from '@/components/date-range-filter';
import { rangeCaption, type MessageRange } from '@/lib/messaging';

export function MessageRangeControl({ value, onChange }: { value: MessageRange; onChange: (r: MessageRange) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <Select value={value.mode} onValueChange={(m) => onChange({ mode: m as MessageRange['mode'] })}>
        <SelectTrigger aria-label="Message date range" data-testid="select-message-range">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="recent">Last 6 months</SelectItem>
          <SelectItem value="archive">Archive (older)</SelectItem>
          <SelectItem value="custom">Custom range</SelectItem>
        </SelectContent>
      </Select>
      {value.mode === 'custom' && (
        <DateRangeFilter
          label="Last message date"
          startDate={value.from}
          endDate={value.to}
          onChange={(r) => onChange({ mode: 'custom', from: r.startDate, to: r.endDate })}
        />
      )}
    </div>
  );
}

export function MessageRangeCaption({ range }: { range: MessageRange }) {
  return <p className="text-xs text-muted-foreground" data-testid="text-message-range-caption">{rangeCaption(range)}</p>;
}
