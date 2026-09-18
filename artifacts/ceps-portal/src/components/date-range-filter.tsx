import React, { useState, useEffect } from 'react';
import { format, startOfToday, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfQuarter, endOfQuarter, parseISO } from 'date-fns';
import { Calendar as CalendarIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface DateRangeFilterProps {
  startDate?: string;
  endDate?: string;
  onChange: (range: { startDate?: string; endDate?: string }) => void;
  label?: string;
  className?: string;
  presentation?: 'nested' | 'single-level';
}

const PRESETS = [
  { label: 'Today', value: 'today' },
  { label: 'This Week', value: 'this_week' },
  { label: 'This Month', value: 'this_month' },
  { label: 'This Quarter', value: 'this_quarter' },
  { label: 'Custom Range', value: 'custom' },
];

export function DateRangeFilter({
  startDate,
  endDate,
  onChange,
  label = 'Date range',
  className,
  presentation = 'nested',
}: DateRangeFilterProps) {
  const [preset, setPreset] = useState<string>(
    startDate || endDate ? 'custom' : ''
  );
  
  useEffect(() => {
    if (!startDate && !endDate) {
      setPreset('');
    } else if (!preset) {
      setPreset('custom');
    }
  }, [startDate, endDate, preset]);

  const today = startOfToday();

  const handlePresetChange = (value: string) => {
    setPreset(value);
    let newStart: Date | undefined;
    let newEnd: Date | undefined;

    switch (value) {
      case 'today':
        newStart = today;
        newEnd = today;
        break;
      case 'this_week':
        newStart = startOfWeek(today, { weekStartsOn: 0 });
        newEnd = endOfWeek(today, { weekStartsOn: 0 });
        break;
      case 'this_month':
        newStart = startOfMonth(today);
        newEnd = endOfMonth(today);
        break;
      case 'this_quarter':
        newStart = startOfQuarter(today);
        newEnd = endOfQuarter(today);
        break;
      case 'custom':
        return;
    }

    if (newStart && newEnd) {
      onChange({
        startDate: format(newStart, 'yyyy-MM-dd'),
        endDate: format(newEnd, 'yyyy-MM-dd'),
      });
    }
  };

  const handleClear = () => {
    setPreset('');
    onChange({ startDate: undefined, endDate: undefined });
  };

  let displayValue = label;
  if (startDate && endDate) {
    try {
      displayValue = `${format(parseISO(startDate), 'MMM d, yy')} - ${format(parseISO(endDate), 'MMM d, yy')}`;
    } catch {
      displayValue = label;
    }
  } else if (startDate) {
    try {
      displayValue = `From ${format(parseISO(startDate), 'MMM d, yy')}`;
    } catch { }
  } else if (endDate) {
    try {
      displayValue = `Until ${format(parseISO(endDate), 'MMM d, yy')}`;
    } catch { }
  }

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              'justify-start text-left font-normal h-9 w-full sm:w-[220px]',
              !startDate && !endDate && 'text-muted-foreground'
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
            <span className="truncate" data-testid="date-range-display">{displayValue}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-4" align="start">
          <div className="space-y-4">
            {presentation === 'single-level' ? (
              <div className="space-y-1" data-testid="date-range-presets">
                {PRESETS.map((p) => (
                  <Button
                    key={p.value}
                    type="button"
                    variant={preset === p.value ? 'secondary' : 'ghost'}
                    className="w-full justify-start"
                    onClick={() => handlePresetChange(p.value)}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Date Range Preset</Label>
                <Select value={preset} onValueChange={handlePresetChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select range..." />
                  </SelectTrigger>
                  <SelectContent>
                    {PRESETS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            
            {preset === 'custom' && (
              <div className="grid grid-cols-2 gap-2 pt-2 border-t">
                <div className="space-y-2">
                  <Label htmlFor="date-range-start" className="text-xs text-muted-foreground">Start Date</Label>
                  <Input
                    id="date-range-start"
                    type="date"
                    value={startDate || ''}
                    max={endDate || undefined}
                    onChange={(e) => onChange({ startDate: e.target.value || undefined, endDate })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="date-range-end" className="text-xs text-muted-foreground">End Date</Label>
                  <Input
                    id="date-range-end"
                    type="date"
                    value={endDate || ''}
                    min={startDate || undefined}
                    onChange={(e) => onChange({ startDate, endDate: e.target.value || undefined })}
                  />
                </div>
              </div>
            )}
            
            {preset === 'custom' && (startDate || endDate) && (
              <div className="pt-2 flex justify-end">
                <Button variant="ghost" size="sm" onClick={handleClear}>Clear</Button>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {(startDate || endDate) && (
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={handleClear} title="Clear dates">
          <X className="h-4 w-4" />
          <span className="sr-only">Clear dates</span>
        </Button>
      )}
    </div>
  );
}
