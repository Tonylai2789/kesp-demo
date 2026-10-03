import type {
  CallSynopsisPlan,
  Feedback,
  LocalizedString,
  ManagementActionPlanV1,
  MentorshipTipPlan,
  WeaknessActionPlan,
  WeaknessItem,
} from '@/types';
import { parseCoachingTip } from './coachingTips';

function asLocalized(value: string | null | undefined): LocalizedString {
  const next = (value ?? '').trim();
  return {
    es: next,
    en: next,
  };
}

function cleanSegment(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeComparable(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueLocalized(values: Array<LocalizedString | null | undefined>, limit = Number.POSITIVE_INFINITY): LocalizedString[] {
  const seen = new Set<string>();
  const next: LocalizedString[] = [];
  for (const value of values) {
    if (!value || (!value.es && !value.en)) continue;
    const normalized = normalizeComparable(value.es || value.en);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(value);
    if (next.length >= limit) break;
  }
  return next;
}

function uniqueStrings(values: Array<string | null | undefined>, limit = Number.POSITIVE_INFINITY): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const cleaned = cleanSegment(value);
    if (!cleaned) continue;
    const normalized = normalizeComparable(cleaned);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(cleaned);
    if (next.length >= limit) break;
  }
  return next;
}

function extractQuotedPhrases(value: string | null | undefined): string[] {
  const text = cleanSegment(value);
  if (!text) return [];
  const quoted = Array.from(text.matchAll(/"([^"]+)"/g))
    .map((match) => cleanSegment(match[1]))
    .filter((item): item is string => Boolean(item));
  if (quoted.length > 0) return quoted;
  return text
    .split(/\s+o\s+(?=")|\s+\/\s+/i)
    .map((item) => cleanSegment(item))
    .filter((item): item is string => Boolean(item));
}

function firstSentence(value: string | null | undefined, maxSentences = 1): string | null {
  const cleaned = cleanSegment(value);
  if (!cleaned) return null;
  const parts = cleaned.match(/[^.!?]+[.!?]?/g)?.map((part) => part.trim()).filter(Boolean) ?? [cleaned];
  return cleanSegment(parts.slice(0, maxSentences).join(' '));
}

function pickDistinctText(
  candidates: Array<string | null | undefined>,
  blocked: Array<string | null | undefined>
): string | null {
  const blockedSet = new Set(blocked.map((item) => normalizeComparable(item)).filter(Boolean));
  for (const candidate of candidates) {
    const cleaned = cleanSegment(candidate);
    if (!cleaned) continue;
    const normalized = normalizeComparable(cleaned);
    if (!normalized || blockedSet.has(normalized)) continue;
    return cleaned;
  }
  return null;
}

function normalizeTrainingLabel(value: string | null | undefined): string | null {
  const cleaned = cleanSegment(value);
  if (!cleaned) return null;
  return cleaned
    .replace(/^qué debió haber dicho\s*:\s*/i, '')
    .replace(/^mentor tips?\s*:\s*/i, '')
    .replace(/^tips? del mentor\s*:\s*/i, '')
    .trim();
}

function isExampleLikeText(value: string | null | undefined): boolean {
  const normalized = normalizeComparable(value);
  if (!normalized) return false;
  return (
    normalized.startsWith('que debio haber dicho') ||
    normalized.startsWith('que puedes decir') ||
    normalized.startsWith('di esto') ||
    normalized.startsWith('ejemplo')
  );
}

function buildWhyItHurtsFallback(weakness: WeaknessItem): string | null {
  const normalized = normalizeComparable(`${weakness.title} ${weakness.detail}`);
  if (!normalized) return null;

  if (
    /\b(proceso|pasos|secuencia|tramite|trámite|como funciona|como seria|como sería|explica)\b/.test(
      normalized
    )
  ) {
    return 'Si el cliente no entiende qué pasa después ni en qué paso va, aumenta la incertidumbre, baja la confianza y se vuelve más fácil que posponga o abandone el proceso.';
  }

  if (/\b(objecion|objeción|rechazo|ahorita no|no me interesa)\b/.test(normalized)) {
    return 'Si la objeción no se maneja con claridad, el cliente siente que no fue escuchado y la conversación pierde tracción para avanzar al siguiente paso.';
  }

  if (/\b(monto|plazo|pago|descuento|mensualidad)\b/.test(normalized)) {
    return 'Si la explicación económica no queda clara, el cliente percibe más riesgo, duda de la oferta y es menos probable que continúe con el proceso.';
  }

  return 'Cuando este punto no queda claro, baja la confianza del cliente y se reduce la probabilidad de mantener el avance comercial de la llamada.';
}

function sanitizeWhyItHurts(params: {
  weakness: WeaknessItem;
  whyItHurts: string | null;
  whatWentWrong: string | null;
  whatToChangeNextCall: string | null;
  examplePhrases: string[];
}): string | null {
  const { weakness, whyItHurts, whatWentWrong, whatToChangeNextCall, examplePhrases } = params;
  const normalizedWhy = normalizeComparable(whyItHurts);
  const blocked = new Set(
    [whatWentWrong, whatToChangeNextCall, ...examplePhrases].map((item) => normalizeComparable(item)).filter(Boolean)
  );

  if (
    !normalizedWhy ||
    blocked.has(normalizedWhy) ||
    isExampleLikeText(whyItHurts)
  ) {
    return buildWhyItHurtsFallback(weakness);
  }

  return whyItHurts;
}

function buildFallbackMentorshipTips(weakness: WeaknessItem, actionPlan: {
  intro: string | null;
  examplePhrase: string | null;
  mentorTips: string[];
}): MentorshipTipPlan[] {
  const distinctTips = uniqueStrings(actionPlan.mentorTips, 1);
  if (distinctTips.length === 0) {
    return [];
  }

  return distinctTips.map((tip) => ({
    skill: asLocalized(weakness.title),
    whenToUseIt: actionPlan.intro ? asLocalized(actionPlan.intro) : null,
    examplePhrase: actionPlan.examplePhrase ? asLocalized(actionPlan.examplePhrase) : null,
    whyItWorks: asLocalized(tip),
  }));
}

function buildFallbackCallSynopsis(weaknessPlan: WeaknessActionPlan | null): CallSynopsisPlan | null {
  if (!weaknessPlan) return null;
  return {
    primaryWeaknessTitle: weaknessPlan.weaknessTitle,
    whatWentWrong: asLocalized(firstSentence(weaknessPlan.whatWentWrong.es, 2) ?? weaknessPlan.whatWentWrong.es),
    whatToDoDifferently: asLocalized(
      firstSentence(weaknessPlan.whatToChangeNextCall.es, 1) ?? weaknessPlan.whatToChangeNextCall.es
    ),
    whatToSay: weaknessPlan.whatToSayNext[0] ?? asLocalized(''),
    whatToTrain: weaknessPlan.whatToTrain[0] ?? asLocalized(weaknessPlan.weaknessTitle),
  };
}

type WeaknessTheme =
  | 'opening_name'
  | 'clarity'
  | 'discovery'
  | 'objection'
  | 'next_step'
  | 'trust'
  | 'generic';

function inferWeaknessTheme(weakness: WeaknessItem): WeaknessTheme {
  const normalized = normalizeComparable(`${weakness.title} ${weakness.detail}`);
  if (!normalized) return 'generic';

  if (/\b(nombre propio|presentacion inicial|apertura|identific)/.test(normalized)) {
    return 'opening_name';
  }
  if (/\b(extensas|poco depuradas|claridad|coherencia|frases demasiado largas|expresion)\b/.test(normalized)) {
    return 'clarity';
  }
  if (/\b(descubrir necesidad|perfilar|personalizar|descubr|necesidad|contexto del cliente)\b/.test(normalized)) {
    return 'discovery';
  }
  if (/\b(objecion|objeción|resistencia|rechazo|desconfianza|no lo necesito|no me interesa|ahorita no)\b/.test(normalized)) {
    return 'objection';
  }
  if (/\b(cierre|seguimiento|proxima accion|próxima acción|compromiso verificable|siguiente paso)\b/.test(normalized)) {
    return 'next_step';
  }
  if (/\b(confianza|respaldo|institucion|institución)\b/.test(normalized)) {
    return 'trust';
  }
  return 'generic';
}

function getSpeakerEvidenceQuote(weakness: WeaknessItem, speaker: 'agent' | 'client'): string | null {
  const evidence = Array.isArray(weakness.evidence) ? weakness.evidence : [];
  const match = evidence.find((item) => {
    const normalized = normalizeComparable(`${item.speaker_display ?? ''} ${item.speaker_label ?? ''}`);
    if (!normalized) return false;
    if (speaker === 'agent') {
      return normalized === 'a' || normalized.includes('agente') || normalized.includes('agent');
    }
    return normalized === 'b' || normalized.includes('cliente') || normalized.includes('customer');
  });
  return cleanSegment(match?.quote);
}

function getCustomerAddress(feedback: Feedback | null | undefined): string {
  const name = cleanSegment(feedback?.customer_name);
  return name ? `Señor(a) ${name}` : 'Señor(a)';
}

function getAgentDisplayName(feedback: Feedback | null | undefined): string {
  return cleanSegment(feedback?.agent_name) ?? 'el agente';
}

function buildThemeSpecificWhatToChangeNextCall(
  theme: WeaknessTheme,
  feedback: Feedback | null | undefined
): string | null {
  const customer = getCustomerAddress(feedback);
  switch (theme) {
    case 'opening_name':
      return `En la próxima llamada, abre con tu nombre completo, la institución y el motivo en una sola frase clara antes de continuar con la oferta para ${customer.toLowerCase()}.`;
    case 'clarity':
      return 'En la próxima llamada, divide la explicación en 2 o 3 bloques cortos, haz una pausa después de cada uno y confirma si el cliente sigue el hilo antes de continuar.';
    case 'discovery':
      return 'En la próxima llamada, haz primero dos preguntas útiles sobre necesidad, momento y capacidad antes de ofrecer monto, beneficios o plazos.';
    case 'objection':
      return 'En la próxima llamada, valida la objeción exacta con una frase breve y responde sólo a esa preocupación antes de volver a proponer cualquier avance.';
    case 'next_step':
      return 'En la próxima llamada, cierra con un siguiente paso verificable: fecha, canal y compromiso concreto de ambas partes.';
    case 'trust':
      return 'En la próxima llamada, baja el ritmo, refuerza respaldo institucional y resuelve primero la duda de confianza antes de empujar la oferta.';
    default:
      return 'En la próxima llamada, conecta tu respuesta con lo que el cliente acaba de decir y termina con un siguiente paso corto y claro.';
  }
}

function buildThemeSpecificPhrases(
  theme: WeaknessTheme,
  feedback: Feedback | null | undefined,
  weakness: WeaknessItem
): string[] {
  const customer = getCustomerAddress(feedback);
  const agentName = getAgentDisplayName(feedback);
  const clientQuote = getSpeakerEvidenceQuote(weakness, 'client');

  switch (theme) {
    case 'opening_name':
      return [
        `${customer}, le habla ${agentName} de Consubanco. Le llamo por su línea de crédito preautorizada y en un minuto le explico si hoy le conviene revisarla.`,
        `${customer}, soy ${agentName} de Consubanco. Antes de avanzar, quiero decirle claramente quién le habla y el motivo de esta llamada.`,
      ];
    case 'clarity':
      return [
        `${customer}, se lo explico rápido en tres puntos: cuánto podría recibir, cuándo sería el descuento y qué tendría que hacer si decide avanzar.`,
        `Voy a ir paso por paso. Primero le confirmo el monto, luego el descuento y al final vemos si le conviene seguir. Si algo no le hace sentido, me detiene y lo revisamos.`,
      ];
    case 'discovery':
      return [
        `${customer}, antes de decirle montos, déjeme hacerle dos preguntas para saber si esto realmente le sirve y en qué escenario le convendría.`,
        `Para no darle una oferta genérica, primero quiero entender para qué lo usaría y qué pago sí le resultaría cómodo.`,
      ];
    case 'objection':
      return [
        clientQuote
          ? `Entiendo lo que me dice sobre “${clientQuote}”. No quiero insistir por insistir; primero aclaremos esa duda y luego vemos si tiene sentido seguir.`
          : `Entiendo su preocupación y no quiero empujarlo sin aclararla. Primero resolvamos ese punto y luego vemos si vale la pena seguir.`,
        `${customer}, si ahorita no es su prioridad, se lo respeto. Dígame qué es lo que más le frena y le respondo sólo esa parte.`,
      ];
    case 'next_step':
      return [
        `${customer}, si le parece, quedamos así: hoy le envío la información y mañana a las 5 le llamo para que me diga si avanzamos o lo dejamos hasta ahí.`,
        `Antes de cerrar, quiero dejarle un siguiente paso claro: ¿prefiere que lo contacte por llamada o por WhatsApp, y qué horario sí le funciona?`,
      ];
    case 'trust':
      return [
        `${customer}, entiendo que quiera confirmar quién le llama. Soy ${agentName} de Consubanco, y si gusta primero le explico el respaldo y luego vemos si la oferta le interesa.`,
        `Es válido que quiera estar seguro antes de avanzar. Primero le aclaro quiénes somos y cómo funciona el trámite, y después decide si seguimos.`,
      ];
    default:
      return [
        `${customer}, con lo que me comenta, no le voy a dar una explicación genérica. Primero aclaro su punto y después le digo qué opción sí tendría sentido revisar.`,
        `Déjeme acomodarlo de forma simple para que usted decida con claridad si esto le conviene o no en esta llamada.`,
      ];
  }
}

function buildThemeSpecificTraining(theme: WeaknessTheme): string[] {
  switch (theme) {
    case 'opening_name':
      return [
        'Apertura con nombre propio + institución + motivo',
        'Presentación inicial en una sola frase clara',
        'Confirmar identidad antes de entrar al pitch',
      ];
    case 'clarity':
      return [
        'Explicación comercial en 3 pasos',
        'Pausas para validar comprensión',
        'Una idea por frase antes de pasar al siguiente dato',
      ];
    case 'discovery':
      return [
        'Preguntas de necesidad antes de cotizar',
        'Personalizar beneficio con lo que el cliente respondió',
        'No ofrecer monto sin contexto del cliente',
      ];
    case 'objection':
      return [
        'Validar la objeción exacta antes de responder',
        'Bajar presión cuando el cliente resiste',
        'Responder una preocupación por vez',
      ];
    case 'next_step':
      return [
        'Cierre con fecha, canal y compromiso verificable',
        'Confirmar quién hace qué después de la llamada',
        'No cerrar con seguimiento ambiguo',
      ];
    case 'trust':
      return [
        'Respaldar institución y proceso antes de presionar',
        'Explicar seguridad y legitimidad con calma',
        'Responder desconfianza antes de volver a vender',
      ];
    default:
      return [
        'Escuchar la señal del cliente antes de responder',
        'Conectar la respuesta con la necesidad real',
        'Cerrar con un siguiente paso corto y claro',
      ];
  }
}

export function buildFallbackWeaknessActionPlan(
  weakness: WeaknessItem,
  feedback?: Feedback | null
): WeaknessActionPlan {
  const parsed = parseCoachingTip(weakness.weakness_improvement_tip);
  const theme = inferWeaknessTheme(weakness);
  const themeSpecificPhrases = buildThemeSpecificPhrases(theme, feedback, weakness);
  const phrases = uniqueStrings(
    [
      ...themeSpecificPhrases,
      ...extractQuotedPhrases(parsed.whatAgentShouldHaveSaid),
      parsed.whatAgentShouldHaveSaid,
    ],
    2
  );
  const whatToChangeNextCall = pickDistinctText(
    [
      buildThemeSpecificWhatToChangeNextCall(theme, feedback),
      firstSentence(parsed.mentorTips[0], 1),
      parsed.remainder,
      parsed.intro,
      weakness.weakness_improvement_tip,
    ],
    [weakness.detail, ...phrases]
  );
  const rawWhyItHurts = pickDistinctText(
    [parsed.remainder, parsed.intro],
    [weakness.detail, whatToChangeNextCall]
  );
  const whyItHurts = sanitizeWhyItHurts({
    weakness,
    whyItHurts: rawWhyItHurts,
    whatWentWrong: weakness.detail,
    whatToChangeNextCall,
    examplePhrases: phrases,
  });
  const trainingItems = uniqueStrings(
    [
      ...buildThemeSpecificTraining(theme),
      normalizeTrainingLabel(weakness.title),
      ...parsed.mentorTips.map((tip) => firstSentence(tip, 1)),
      parsed.intro,
    ],
    3
  );

  return {
    weaknessTitle: weakness.title,
    weaknessDetail: weakness.detail,
    whatWentWrong: asLocalized(weakness.detail),
    whenItHappened: parsed.intro ? asLocalized(parsed.intro) : null,
    whyItHurts: whyItHurts ? asLocalized(whyItHurts) : null,
    whatToChangeNextCall: asLocalized(whatToChangeNextCall ?? weakness.detail),
    whatToSayNext: uniqueLocalized(phrases.map((phrase) => asLocalized(phrase)), 2),
    whatToTrain: uniqueLocalized(trainingItems.map((item) => asLocalized(item)), 3),
    mentorshipTips: buildFallbackMentorshipTips(weakness, {
      intro: parsed.intro,
      examplePhrase: phrases[0] ?? null,
      mentorTips: parsed.mentorTips,
    }),
  };
}

function dedupeWeaknessPlanSections(plan: WeaknessActionPlan): WeaknessActionPlan {
  const whatWentWrong = localizeText(plan.whatWentWrong, 'es');
  const whyItHurts = sanitizeWhyItHurts({
    weakness: {
      title: plan.weaknessTitle,
      detail: plan.weaknessDetail,
    } as WeaknessItem,
    whyItHurts: localizeText(plan.whyItHurts, 'es'),
    whatWentWrong,
    whatToChangeNextCall: localizeText(plan.whatToChangeNextCall, 'es'),
    examplePhrases: plan.whatToSayNext.map((item) => localizeText(item, 'es')),
  });
  const whatToChange = localizeText(plan.whatToChangeNextCall, 'es');

  const keepWhyItHurts =
    whyItHurts &&
    normalizeComparable(whyItHurts) !== normalizeComparable(whatWentWrong);
  const keepWhatToChange =
    whatToChange &&
    normalizeComparable(whatToChange) !== normalizeComparable(whatWentWrong) &&
    normalizeComparable(whatToChange) !== normalizeComparable(whyItHurts);

  const whatToSayNext = uniqueLocalized(plan.whatToSayNext, 2).filter((item) => {
    const normalized = normalizeComparable(localizeText(item, 'es'));
    return (
      normalized !== normalizeComparable(whatWentWrong) &&
      normalized !== normalizeComparable(whyItHurts) &&
      normalized !== normalizeComparable(whatToChange)
    );
  });

  const whatToTrain = uniqueLocalized(plan.whatToTrain, 3).filter((item) => {
    const normalized = normalizeComparable(localizeText(item, 'es'));
    return (
      normalized !== normalizeComparable(whatWentWrong) &&
      normalized !== normalizeComparable(whyItHurts) &&
      normalized !== normalizeComparable(whatToChange)
    );
  });

  const mentorshipTips = plan.mentorshipTips.filter((tip) => {
    const combined = [
      localizeText(tip.skill, 'es'),
      localizeText(tip.examplePhrase, 'es'),
      localizeText(tip.whyItWorks, 'es'),
    ]
      .filter(Boolean)
      .join(' ');
    const normalized = normalizeComparable(combined);
    return (
      normalized &&
      normalized !== normalizeComparable(whatWentWrong) &&
      normalized !== normalizeComparable(whyItHurts) &&
      normalized !== normalizeComparable(whatToChange)
    );
  }).slice(0, 1);

  return {
    ...plan,
    whyItHurts: keepWhyItHurts && whyItHurts ? asLocalized(whyItHurts) : null,
    whatToChangeNextCall: keepWhatToChange ? plan.whatToChangeNextCall : asLocalized(''),
    whatToSayNext,
    whatToTrain,
    mentorshipTips,
  };
}

export function getWeaknessActionPlan(
  feedback: Feedback | null | undefined,
  weakness: WeaknessItem | null | undefined
): WeaknessActionPlan | null {
  if (!feedback || !weakness) return null;
  const structuredPlan = feedback.management_action_v1?.weaknessPlans?.find(
    (plan) =>
      plan.weaknessTitle === weakness.title ||
      (plan.weaknessTitle.trim().toLowerCase() === weakness.title.trim().toLowerCase() &&
        plan.weaknessDetail === weakness.detail)
  );
  return dedupeWeaknessPlanSections(structuredPlan ?? buildFallbackWeaknessActionPlan(weakness, feedback));
}

export function getFeedbackManagementActionPlan(feedback: Feedback | null | undefined): ManagementActionPlanV1 | null {
  if (!feedback) return null;

  const basePlan = feedback.management_action_v1
    ? {
        ...feedback.management_action_v1,
        weaknessPlans: feedback.management_action_v1.weaknessPlans.map(dedupeWeaknessPlanSections),
      }
    : null;

  if (basePlan) {
    return {
      ...basePlan,
      phraseBankPreview: uniqueLocalized(basePlan.phraseBankPreview, 3),
      trainingFocus: uniqueLocalized(basePlan.trainingFocus, 3),
      callSynopsis:
        basePlan.callSynopsis ??
        buildFallbackCallSynopsis(basePlan.weaknessPlans[0] ?? null),
    };
  }

  const primaryWeakness = feedback.agent_weaknesses?.[0] ?? null;
  const primaryWeaknessPlan = primaryWeakness
    ? dedupeWeaknessPlanSections(buildFallbackWeaknessActionPlan(primaryWeakness, feedback))
    : null;

  return {
    summary: primaryWeaknessPlan?.whatWentWrong ?? null,
    nextActionSummary: feedback.suggested_followup_message
      ? asLocalized(feedback.suggested_followup_message)
      : null,
    phraseBankPreview: primaryWeaknessPlan ? uniqueLocalized(primaryWeaknessPlan.whatToSayNext, 3) : [],
    trainingFocus: primaryWeaknessPlan ? uniqueLocalized(primaryWeaknessPlan.whatToTrain, 3) : [],
    weaknessPlans: (feedback.agent_weaknesses ?? []).map((weakness) =>
      dedupeWeaknessPlanSections(buildFallbackWeaknessActionPlan(weakness, feedback))
    ),
    callSynopsis: buildFallbackCallSynopsis(primaryWeaknessPlan),
  };
}

export function localizeText(value: LocalizedString | null | undefined, language: string): string {
  if (!value) return '';
  if (language.startsWith('es')) {
    return value.es || value.en;
  }
  return value.en || value.es;
}
