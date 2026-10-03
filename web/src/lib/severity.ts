import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface SeverityDisplayConfig {
  icon: LucideIcon;
  className: string;
}

const SEVERITY_DISPLAY: Record<string, SeverityDisplayConfig> = {
  severe: {
    icon: AlertTriangle,
    className:
      "bg-red-200 dark:bg-red-950 text-red-800 dark:text-red-200 border-red-400 dark:border-red-700",
  },
  critical: {
    icon: AlertTriangle,
    className:
      "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 border-red-300 dark:border-red-700",
  },
  "moderate-severe": {
    icon: AlertCircle,
    className:
      "bg-orange-200 dark:bg-orange-950 text-orange-800 dark:text-orange-200 border-orange-400 dark:border-orange-700",
  },
  moderate: {
    icon: AlertCircle,
    className:
      "bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 border-orange-300 dark:border-orange-700",
  },
  "moderate-minor": {
    icon: Info,
    className:
      "bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700",
  },
  minor: {
    icon: Info,
    className:
      "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600",
  },
};

export function getSeverityDisplayConfig(
  severity: string | null | undefined
): SeverityDisplayConfig | null {
  if (!severity) {
    return null;
  }
  return SEVERITY_DISPLAY[severity] ?? null;
}
