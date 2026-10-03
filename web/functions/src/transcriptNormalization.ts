const OTHER_BANK_HINTS = [
  "bbva",
  "banorte",
  "santander",
  "citibanamex",
  "banamex",
  "banco azteca",
  "hsbc",
  "scotiabank",
  "inbursa",
  "banregio",
  "bancoppel",
];

const OPENING_HINTS = [
  "me comunico",
  "le hablo",
  "habla",
  "hablo",
  "soy",
  "mi nombre",
  "ejecutiv",
  "asesor",
  "buenos dias",
  "buenas tardes",
  "llamo",
];

const CONSUBANCO_VARIANT_PATTERNS: Array<{ regex: RegExp; requiresOpeningContext: boolean }> = [
  { regex: /\bconsubancom\b/gi, requiresOpeningContext: false },
  { regex: /\bconsumanco\b/gi, requiresOpeningContext: false },
  { regex: /\bconcho\s+banco\b/gi, requiresOpeningContext: false },
  { regex: /\bconsu\s+banco\b/gi, requiresOpeningContext: true },
  { regex: /\bcon\s+su\s+banco\b/gi, requiresOpeningContext: true },
];

/** Documents the normalizeSearchText behavior. */
function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Documents the hasOpeningContext behavior. */
function hasOpeningContext(value: string, segmentIndex: number): boolean {
  if (segmentIndex <= 2) {
    return true;
  }
  const normalized = normalizeSearchText(value);
  return OPENING_HINTS.some(/** Handles the callback for this operation. */(hint) => normalized.includes(hint));
}

/** Documents the shouldSkipNormalization behavior. */
function shouldSkipNormalization(value: string): boolean {
  const normalized = normalizeSearchText(value);
  return OTHER_BANK_HINTS.some(/** Handles the callback for this operation. */(hint) => normalized.includes(hint));
}

/** Documents the normalizeConsubancoVariants behavior. */
function normalizeConsubancoVariants(value: string, segmentIndex: number): { text: string; replaced: boolean } {
  if (!value || shouldSkipNormalization(value)) {
    return { text: value, replaced: false };
  }

  let next = value;
  let replaced = false;
  const openingContext = hasOpeningContext(value, segmentIndex);

  for (const pattern of CONSUBANCO_VARIANT_PATTERNS) {
    if (pattern.requiresOpeningContext && !openingContext) {
      continue;
    }
    if (pattern.regex.test(next)) {
      next = next.replace(pattern.regex, "Consubanco");
      replaced = true;
    }
  }

  return { text: next, replaced };
}

/** Documents the normalizeTranscriptForAnalysis behavior. */
export function normalizeTranscriptForAnalysis(transcript: any): any {
  if (!transcript || typeof transcript !== "object") {
    return transcript;
  }

  const cloned = JSON.parse(JSON.stringify(transcript));
  const segments = Array.isArray(cloned?.segments) ? cloned.segments : [];
  const replacements: Array<{ segment_index: number; original: string; normalized: string }> = [];

  segments.forEach(/** Handles the callback for this operation. */(segment: any, index: number) => {
    if (!segment || typeof segment.text !== "string") {
      return;
    }
    const normalized = normalizeConsubancoVariants(segment.text, index);
    if (normalized.replaced && normalized.text !== segment.text) {
      replacements.push({
        segment_index: index,
        original: segment.text,
        normalized: normalized.text,
      });
      segment.original_text = segment.text;
      segment.text = normalized.text;
      segment.normalized_text = normalized.text;
    }
  });

  cloned.normalization = {
    institution: "Consubanco",
    strategy: "consubanco_asr_variants_v1",
    replacements,
  };

  return cloned;
}
