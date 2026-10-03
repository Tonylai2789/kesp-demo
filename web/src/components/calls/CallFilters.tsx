import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CallCategory, CallStatus } from '@/types';

interface CallFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  category: CallCategory | 'all';
  onCategoryChange: (value: CallCategory | 'all') => void;
  status: CallStatus | 'all';
  onStatusChange: (value: CallStatus | 'all') => void;
}

/** Renders the CallFilters component. */
export function CallFilters({
  search,
  onSearchChange,
  category,
  onCategoryChange,
  status,
  onStatusChange,
}: CallFiltersProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col sm:flex-row gap-4">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('calls.search')}
          value={search}
          onChange={/** Handles the onChange interaction. */ (e) => onSearchChange(e.target.value)}
          className="pl-9"
        />
      </div>

      <Select value={category} onValueChange={/** Handles the onValueChange interaction. */ (v) => onCategoryChange(v as CallCategory | 'all')}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder={t('calls.filterCategory')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('calls.all')}</SelectItem>
          <SelectItem value="good">{t('calls.good')}</SelectItem>
          <SelectItem value="medium">{t('calls.medium')}</SelectItem>
          <SelectItem value="bad">{t('calls.bad')}</SelectItem>
          <SelectItem value="unknown">{t('calls.unknown')}</SelectItem>
        </SelectContent>
      </Select>

      <Select value={status} onValueChange={/** Handles the onValueChange interaction. */ (v) => onStatusChange(v as CallStatus | 'all')}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder={t('calls.filterStatus')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('calls.all')}</SelectItem>
          <SelectItem value="uploaded">{t('calls.uploaded')}</SelectItem>
          <SelectItem value="transcribing">{t('calls.transcribing')}</SelectItem>
          <SelectItem value="analyzing">{t('calls.analyzing')}</SelectItem>
          <SelectItem value="canceled">{t('calls.canceled')}</SelectItem>
          <SelectItem value="complete">{t('calls.complete')}</SelectItem>
          <SelectItem value="error">{t('calls.error')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
