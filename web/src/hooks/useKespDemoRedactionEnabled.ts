import { useEffect, useState } from "react";
import {
  isKespDemoRedactionEnabled,
  subscribeToKespDemoRedaction,
} from "@/lib/kespDemoRedaction";

export function useKespDemoRedactionEnabled(): boolean {
  const [enabled, setEnabled] = useState(() => isKespDemoRedactionEnabled());

  useEffect(() => {
    return subscribeToKespDemoRedaction(() => {
      setEnabled(isKespDemoRedactionEnabled());
    });
  }, []);

  return enabled;
}
