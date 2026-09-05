import * as React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SearchableSelectOption = {
  value: string;
  label: string;
  subtitle?: string;
};

export type SearchableSelectProps = {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  onSearchChange?: (search: string) => void;
  selectedLabelFallback?: string;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  loading?: boolean;
  allowClear?: boolean;
  clearLabel?: string;
  clearValue?: string;
  'data-testid'?: string;
};

export function SearchableSelect({
  value,
  onValueChange,
  options,
  onSearchChange,
  selectedLabelFallback,
  placeholder = "Select...",
  emptyMessage = "No results found.",
  disabled = false,
  loading = false,
  allowClear = false,
  clearLabel = "None",
  clearValue = "none",
  'data-testid': testId,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [rememberedLabel, setRememberedLabel] = React.useState(selectedLabelFallback);

  React.useEffect(() => {
    if (onSearchChange) {
      onSearchChange(search);
    }
  }, [search, onSearchChange]);

  const selectedOption = options.find((opt) => opt.value === value);
  React.useEffect(() => {
    if (selectedOption) setRememberedLabel(selectedOption.label);
    else if (selectedLabelFallback) setRememberedLabel(selectedLabelFallback);
  }, [selectedOption, selectedLabelFallback]);

  const displayLabel = selectedOption 
    ? selectedOption.label 
    : (value && value !== clearValue && rememberedLabel ? rememberedLabel : placeholder);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('w-full justify-between font-normal', (!value || value === clearValue) && 'text-muted-foreground')}
          disabled={disabled}
          data-testid={testId}
        >
          <span className="truncate">{displayLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Search..."
            value={search}
            onValueChange={setSearch}
            data-testid={testId ? `${testId}-search` : undefined}
          />
          <CommandList>
            <CommandEmpty>{loading ? 'Loading...' : emptyMessage}</CommandEmpty>
            <CommandGroup>
              {allowClear && (
                <CommandItem
                  value={`clear empty none ${clearLabel}`}
                  onSelect={() => {
                    onValueChange(clearValue);
                    setRememberedLabel(undefined);
                    setOpen(false);
                    setSearch('');
                  }}
                  data-testid={testId ? `${testId}-option-none` : undefined}
                >
                  {clearLabel}
                  <Check className={cn('ml-auto h-4 w-4', value === clearValue ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              )}
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.subtitle || ''} ${option.value}`}
                  onSelect={() => {
                    onValueChange(option.value);
                    setRememberedLabel(option.label);
                    setOpen(false);
                    setSearch('');
                  }}
                  data-testid={testId ? `${testId}-option-${option.value}` : undefined}
                >
                  <div className="flex flex-col">
                    <span>{option.label}</span>
                    {option.subtitle && <span className="text-xs text-muted-foreground">{option.subtitle}</span>}
                  </div>
                  <Check className={cn('ml-auto h-4 w-4', value === option.value ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
