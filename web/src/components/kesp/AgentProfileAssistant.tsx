import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Icon, type IconName } from '@/components/kesp/icons';
import { Button, Pill } from '@/components/kesp/primitives';
import { appendReturnTo } from '@/lib/returnTo';
import { getKespLocale } from '@/lib/kespI18n';
import { useAuth } from '@/contexts/useAuth';
import { useDemoProcessingStatus } from '@/hooks/useDemoProcessingStatus';
import { DemoProcessingStatus } from '@/components/kesp/DemoProcessingStatus';
import {
  askAgentProfileAssistant,
  getAgentProfileAssistantChat,
  getAgentProfileAssistantChatStatus,
  resetAgentProfileAssistantChat,
  type AgentProfileAssistantChat,
  type AgentProfileAssistantChatMessage,
  type AgentProfileAssistantChatResponse,
  type AgentProfileAssistantChatStatusResponse,
  type AgentProfileAssistantLanguage,
  type AgentProfileAssistantReference,
  type AgentProfileAssistantStructuredBlock,
  type AgentProfileAssistantStructuredContent,
  type AgentProfileAssistantStructuredIcon,
  type AgentProfileAssistantStructuredTone,
} from '@/services/functions';

interface AgentProfileAssistantProviderProps {
  agentAnalysisId: string;
  salesAgentName: string;
  enabled?: boolean;
  children: ReactNode;
}

interface AgentProfileAssistantController {
  agentAnalysisId: string;
  salesAgentName: string;
  chat: AgentProfileAssistantChat | null;
  draft: string;
  loading: boolean;
  sending: boolean;
  resetting: boolean;
  error: string | null;
  pendingQuestion: string | null;
  assistantLanguage: AgentProfileAssistantLanguage;
  examplePrompts: string[];
  floatingOpen: boolean;
  setDraft: (value: string) => void;
  setFloatingOpen: (open: boolean) => void;
  closeFloating: () => void;
  resetChat: () => Promise<void>;
  sendQuestion: (questionOverride?: string) => Promise<void>;
  openReference: (reference: AgentProfileAssistantReference) => void;
}

interface MaybeCallableError {
  code?: string;
  message?: string;
}

interface AgentProfileAssistantSurfaceProps {
  variant: 'floating' | 'inline';
  autoFocus?: boolean;
  onClose?: () => void;
}

interface AgentProfileAssistantMessageProps {
  message: AgentProfileAssistantChatMessage;
  assistantName: string;
  userName: string;
  language: string;
  openReference: (reference: AgentProfileAssistantReference) => void;
}

interface AgentProfileAssistantStructuredContentProps {
  content: AgentProfileAssistantStructuredContent;
}

interface AgentProfileAssistantBlockProps {
  block: AgentProfileAssistantStructuredBlock;
}

const AgentProfileAssistantContext = createContext<AgentProfileAssistantController | null>(null);
const assistantChatLoadPromises = new Map<string, Promise<AgentProfileAssistantChatResponse>>();
const ASSISTANT_VISIBLE_PROMPT_LIMIT = 3;
const ASSISTANT_CHAT_STATUS_POLL_MS = 60_000;
const ASSISTANT_CHAT_STATUS_MAX_BACKOFF_MS = 10 * 60_000;

/** Documents the isAssistantCallableErrorCode behavior. */
function isAssistantCallableErrorCode(code: string): boolean {
  return code.startsWith('functions/') || [
    'resource-exhausted',
    'unavailable',
    'internal',
    'invalid-argument',
  ].includes(code);
}

/** Documents the isDisplayableAssistantErrorMessage behavior. */
function isDisplayableAssistantErrorMessage(message: string): boolean {
  const normalized = message.trim();
  if (!normalized || normalized.length > 300) {
    return false;
  }
  return !['internal', 'unknown', 'unauthenticated'].includes(normalized.toLowerCase());
}

/** Documents the getAssistantAskErrorMessage behavior. */
function getAssistantAskErrorMessage(error: unknown, fallback: string): string {
  const fnError = error as MaybeCallableError | null;
  const code = typeof fnError?.code === 'string' ? fnError.code : '';
  const message = typeof fnError?.message === 'string' ? fnError.message.trim() : '';
  if (isAssistantCallableErrorCode(code) && isDisplayableAssistantErrorMessage(message)) {
    return message;
  }
  return fallback;
}

/** Documents the loadAssistantChatOnce behavior. */
function loadAssistantChatOnce(
  loadKey: string,
  agentAnalysisId: string
): Promise<AgentProfileAssistantChatResponse> {
  const existing = assistantChatLoadPromises.get(loadKey);
  if (existing) {
    return existing;
  }

  /** Calls an external SDK or API dependency. */
  const request = getAgentProfileAssistantChat(agentAnalysisId).finally(
    /** Handles the callback for this operation. */
    () => {
      assistantChatLoadPromises.delete(loadKey);
    }
  );
  assistantChatLoadPromises.set(loadKey, request);
  return request;
}

/** Documents the appendOptimisticUserMessage behavior. */
function appendOptimisticUserMessage(
  chat: AgentProfileAssistantChat,
  message: AgentProfileAssistantChatMessage
): AgentProfileAssistantChat {
  return {
    ...chat,
    messages: [...chat.messages, message],
  };
}

/** Documents the removeOptimisticUserMessage behavior. */
function removeOptimisticUserMessage(
  chat: AgentProfileAssistantChat,
  messageId: string
): AgentProfileAssistantChat {
  return {
    ...chat,
    messages: chat.messages.filter(
      /** Handles the callback for this operation. */
      (message) => message.id !== messageId
    ),
  };
}

/** Checks whether the lightweight chat status implies the full chat should be refreshed. */
function shouldFetchAssistantChatFromStatus(
  current: AgentProfileAssistantChat | null,
  status: AgentProfileAssistantChatStatusResponse['status']
): boolean {
  if (!status.exists) return false;
  if (!current) return true;
  if (status.assistantBehaviorVersion !== current.assistantBehaviorVersion) return true;
  if (status.messageCount !== current.messages.length) return true;
  const latestMessage = current.messages[current.messages.length - 1] ?? null;
  if (status.latestMessageId && latestMessage?.id !== status.latestMessageId) return true;
  const currentUpdatedAt = current.updatedAtMs ?? 0;
  return Boolean(status.updatedAtMs && status.updatedAtMs > currentUpdatedAt);
}

/** Documents the getAssistantMessageClassName behavior. */
function getAssistantMessageClassName(message: AgentProfileAssistantChatMessage): string {
  return [
    'kesp-assistant-msg',
    message.role === 'user' ? 'kesp-assistant-msg-user' : 'kesp-assistant-msg-assistant',
  ].join(' ');
}

/** Returns the latest assistant-generated follow-up prompts, falling back only before Arvo has answered. */
function getAssistantVisiblePrompts(
  chat: AgentProfileAssistantChat | null,
  fallbackPrompts: string[]
): string[] {
  const latestAssistantMessage = [...(chat?.messages ?? [])]
    .reverse()
    .find(
      /** Finds the latest assistant response in the current chat. */
      (message) => message.role === 'assistant'
    );
  const suggestedQuestions = latestAssistantMessage?.suggestedQuestions?.filter(
    /** Keeps valid suggested prompt strings. */
    (question) => typeof question === 'string' && question.trim().length > 0
  );
  return suggestedQuestions && suggestedQuestions.length > 0
    ? suggestedQuestions.slice(0, ASSISTANT_VISIBLE_PROMPT_LIMIT)
    : fallbackPrompts.slice(0, ASSISTANT_VISIBLE_PROMPT_LIMIT);
}

/** Maps model-safe structured response icons onto the local KESP icon set. */
function getStructuredIconName(icon: AgentProfileAssistantStructuredIcon | undefined): IconName {
  return icon ?? 'info';
}

/** Maps structured response tones to stable CSS class suffixes. */
function getStructuredToneClass(tone: AgentProfileAssistantStructuredTone | undefined): string {
  return tone ?? 'neutral';
}

/** Formats assistant message timestamps in the active KESP locale. */
function formatAssistantMessageTime(createdAtMs: number, language: string): string {
  if (!Number.isFinite(createdAtMs)) {
    return '';
  }
  return new Intl.DateTimeFormat(getKespLocale(language), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(createdAtMs));
}

/** Keeps the assistant textarea height matched to its current content. */
function resizeAssistantTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) {
    return;
  }
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
}

/** Provides one shared agent-profile assistant state instance to every rendered surface. */
export function AgentProfileAssistantProvider({
  agentAnalysisId,
  salesAgentName,
  enabled = true,
  children,
}: AgentProfileAssistantProviderProps) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { canStart, checkCanStart } = useDemoProcessingStatus();
  const navigate = useNavigate();
  const location = useLocation();

  const [floatingOpen, setFloatingOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [chat, setChat] = useState<AgentProfileAssistantChat | null>(null);

  const loadRequestRef = useRef(0);
  const sendRequestRef = useRef(0);
  const sendingRef = useRef(false);
  const chatRef = useRef<AgentProfileAssistantChat | null>(null);
  const statusRefreshInFlightRef = useRef(false);
  const stateKeyRef = useRef('');
  const returnTo = location.pathname;

  const assistantLanguage: AgentProfileAssistantLanguage = useMemo(
    /** Handles the callback for this operation. */
    () =>
      typeof i18n.language === 'string' && i18n.language.toLowerCase().startsWith('en') ? 'en' : 'es',
    [i18n.language]
  );

  const loadKey = useMemo(
    /** Handles the callback for this operation. */
    () => `${user?.uid ?? 'signed-out'}:${agentAnalysisId}:${assistantLanguage}`,
    [agentAnalysisId, assistantLanguage, user?.uid]
  );

  useEffect(
    /** Keeps the latest chat available to background status polling without restarting timers. */
    () => {
      chatRef.current = chat;
    },
    [chat]
  );

  useEffect(
    /** Handles the callback for this operation. */
    () => {
      const requestId = loadRequestRef.current + 1;
      loadRequestRef.current = requestId;
      sendRequestRef.current += 1;
      stateKeyRef.current = loadKey;
      sendingRef.current = false;

      setChat(null);
      setDraft('');
      setError(null);
      setSending(false);
      setResetting(false);
      setPendingQuestion(null);

      if (!enabled) {
        setLoading(false);
        return;
      }

      if (!user?.uid) {
        setLoading(false);
        setError(t('kesp.agent.assistant.errors.notSignedIn'));
        return;
      }

      let cancelled = false;
      setLoading(true);

      loadAssistantChatOnce(loadKey, agentAnalysisId)
        .then(
          /** Handles the callback for this operation. */
          (result) => {
            if (cancelled || loadRequestRef.current !== requestId || stateKeyRef.current !== loadKey) {
              return;
            }
            setChat(result.chat);
          }
        )
        .catch(
          /** Handles the callback for this operation. */
          (err) => {
            console.warn('Failed to load agent profile assistant chat:', err);
            if (cancelled || loadRequestRef.current !== requestId || stateKeyRef.current !== loadKey) {
              return;
            }
            setError(t('kesp.agent.assistant.errors.loadFailed'));
          }
        )
        .finally(
          /** Handles the callback for this operation. */
          () => {
            if (cancelled || loadRequestRef.current !== requestId || stateKeyRef.current !== loadKey) {
              return;
            }
            setLoading(false);
          }
        );

      return /** Handles the callback for this operation. */ () => {
        cancelled = true;
      };
    },
    [agentAnalysisId, enabled, loadKey, t, user?.uid]
  );

  useEffect(
    /** Polls lightweight chat status only while the assistant is open and the tab is visible. */
    () => {
      if (!enabled || !floatingOpen || !user?.uid) {
        return undefined;
      }
      let cancelled = false;
      let timeoutId: number | null = null;
      let failureCount = 0;

      const scheduleNext = (delayMs: number) => {
        if (cancelled) return;
        timeoutId = window.setTimeout(pollStatus, delayMs);
      };

      const pollStatus = async () => {
        if (cancelled) return;
        if (document.visibilityState !== 'visible' || statusRefreshInFlightRef.current || loading || resetting || sendingRef.current) {
          scheduleNext(ASSISTANT_CHAT_STATUS_POLL_MS);
          return;
        }

        const refreshStateKey = stateKeyRef.current;
        statusRefreshInFlightRef.current = true;
        try {
          const statusResult = await getAgentProfileAssistantChatStatus(agentAnalysisId);
          if (cancelled || stateKeyRef.current !== refreshStateKey) return;
          if (shouldFetchAssistantChatFromStatus(chatRef.current, statusResult.status)) {
            const chatResult = await getAgentProfileAssistantChat(agentAnalysisId);
            if (!cancelled && stateKeyRef.current === refreshStateKey) {
              setChat(chatResult.chat);
            }
          }
          failureCount = 0;
          scheduleNext(ASSISTANT_CHAT_STATUS_POLL_MS);
        } catch (err) {
          console.warn('Failed to refresh agent profile assistant chat status:', err);
          failureCount += 1;
          const backoffMs = Math.min(
            ASSISTANT_CHAT_STATUS_MAX_BACKOFF_MS,
            ASSISTANT_CHAT_STATUS_POLL_MS * 2 ** Math.min(failureCount, 4)
          );
          scheduleNext(backoffMs);
        } finally {
          statusRefreshInFlightRef.current = false;
        }
      };

      scheduleNext(ASSISTANT_CHAT_STATUS_POLL_MS);
      return /** Clears the background assistant chat status timer. */ () => {
        cancelled = true;
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
      };
    },
    [agentAnalysisId, enabled, floatingOpen, loading, resetting, user?.uid]
  );

  const closeFloating = useCallback(
    /** Handles the callback for this operation. */
    () => {
      setFloatingOpen(false);
    },
    []
  );

  const openReference = useCallback(
    /** Handles the callback for this operation. */
    (reference: AgentProfileAssistantReference) => {
      if (reference.type !== 'call') {
        return;
      }
      navigate(appendReturnTo(`/kesp/call/${encodeURIComponent(reference.id)}`, returnTo));
    },
    [navigate, returnTo]
  );

  const sendQuestion = useCallback(
    /** Handles the callback for this operation. */
    async (questionOverride?: string) => {
      const question = (questionOverride ?? draft).trim();
      if (!enabled || !canStart || !question || sendingRef.current || loading || !chat) {
        return;
      }
      if (!user?.uid) {
        setError(t('kesp.agent.assistant.errors.notSignedIn'));
        return;
      }

      const requestId = sendRequestRef.current + 1;
      const sendStateKey = stateKeyRef.current;
      const optimisticMessageId = `pending-${requestId}-${Date.now()}`;
      const optimisticMessage: AgentProfileAssistantChatMessage = {
        id: optimisticMessageId,
        role: 'user',
        content: question,
        createdAtMs: Date.now(),
      };

      sendRequestRef.current = requestId;
      sendingRef.current = true;
      setSending(true);
      setError(null);
      setPendingQuestion(question);
      setChat(
        /** Handles the callback for this operation. */
        (current) => (current ? appendOptimisticUserMessage(current, optimisticMessage) : current)
      );

      if (!questionOverride) {
        setDraft('');
      }

      try {
        if (!(await checkCanStart())) throw new Error(t('kesp.processing.readOnly'));
        /** Calls an external SDK or API dependency. */
        const result = await askAgentProfileAssistant({
          agentAnalysisId,
          question,
          language: assistantLanguage,
        });
        if (sendRequestRef.current !== requestId || stateKeyRef.current !== sendStateKey) {
          return;
        }
        setChat(result.chat);
      } catch (err) {
        console.warn('Failed to ask agent profile assistant:', err);
        if (sendRequestRef.current !== requestId || stateKeyRef.current !== sendStateKey) {
          return;
        }
        const askErrorMessage = getAssistantAskErrorMessage(
          err,
          t('kesp.agent.assistant.errors.askFailed')
        );
        setError(askErrorMessage);
        toast.error(askErrorMessage);
        setChat(
          /** Handles the callback for this operation. */
          (current) => (current ? removeOptimisticUserMessage(current, optimisticMessageId) : current)
        );
        if (!questionOverride) {
          setDraft(question);
        }
      } finally {
        if (sendRequestRef.current === requestId && stateKeyRef.current === sendStateKey) {
          sendingRef.current = false;
          setSending(false);
          setPendingQuestion(null);
        }
      }
    },
    [agentAnalysisId, assistantLanguage, canStart, checkCanStart, chat, draft, enabled, loading, t, user?.uid]
  );

  const resetChat = useCallback(
    /** Handles the callback for this operation. */
    async () => {
      if (loading || sendingRef.current || resetting) {
        return;
      }
      if (!user?.uid) {
        setError(t('kesp.agent.assistant.errors.notSignedIn'));
        return;
      }

      const resetStateKey = stateKeyRef.current;
      sendRequestRef.current += 1;
      sendingRef.current = false;
      setResetting(true);
      setSending(false);
      setPendingQuestion(null);
      setError(null);

      try {
        /** Calls an external SDK or API dependency. */
        const result = await resetAgentProfileAssistantChat(agentAnalysisId);
        if (stateKeyRef.current !== resetStateKey) {
          return;
        }
        assistantChatLoadPromises.delete(loadKey);
        setChat(result.chat);
        setDraft('');
        toast.success(t('kesp.agent.assistant.resetSuccess'));
      } catch (err) {
        console.warn('Failed to reset agent profile assistant chat:', err);
        if (stateKeyRef.current !== resetStateKey) {
          return;
        }
        const resetErrorMessage = getAssistantAskErrorMessage(
          err,
          t('kesp.agent.assistant.errors.resetFailed')
        );
        setError(resetErrorMessage);
        toast.error(resetErrorMessage);
      } finally {
        if (stateKeyRef.current === resetStateKey) {
          setResetting(false);
        }
      }
    },
    [agentAnalysisId, loadKey, loading, resetting, t, user?.uid]
  );

  const fallbackPrompts = useMemo(
    /** Handles the callback for this operation. */
    () => [
      t('kesp.agent.assistant.examples.howGoing'),
      t('kesp.agent.assistant.examples.scoreDrop'),
      t('kesp.agent.assistant.examples.coachFirst'),
      t('kesp.agent.assistant.examples.pendingReminders'),
    ],
    [t]
  );
  const examplePrompts = useMemo(
    /** Handles the callback for this operation. */
    () => getAssistantVisiblePrompts(chat, fallbackPrompts),
    [chat, fallbackPrompts]
  );

  const controller = useMemo(
    /** Handles the callback for this operation. */
    () => ({
      agentAnalysisId,
      salesAgentName,
      chat,
      draft,
      loading,
      sending,
      resetting,
      error,
      pendingQuestion,
      assistantLanguage,
      examplePrompts,
      floatingOpen,
      setDraft,
      setFloatingOpen,
      closeFloating,
      resetChat,
      sendQuestion,
      openReference,
    }),
    [
      agentAnalysisId,
      assistantLanguage,
      chat,
      closeFloating,
      draft,
      error,
      examplePrompts,
      floatingOpen,
      loading,
      openReference,
      pendingQuestion,
      resetChat,
      resetting,
      salesAgentName,
      sendQuestion,
      sending,
    ]
  );

  return (
    <AgentProfileAssistantContext.Provider value={controller}>
      {children}
    </AgentProfileAssistantContext.Provider>
  );
}

/** Returns the shared KESP agent-profile assistant controller. */
function useAgentProfileAssistant(): AgentProfileAssistantController {
  const controller = useContext(AgentProfileAssistantContext);
  if (!controller) {
    throw new Error('AgentProfileAssistant components must be rendered inside AgentProfileAssistantProvider');
  }
  return controller;
}

/** Renders a metrics block as scan-friendly value chips. */
function AgentProfileAssistantMetricsBlock({ block }: AgentProfileAssistantBlockProps) {
  if (block.type !== 'metrics') {
    return null;
  }
  return (
    <div className="kesp-assistant-metrics-row">
      {block.items.map(
        /** Handles the callback for this operation. */
        (item, index) => (
          <div
            key={`${item.label}:${item.value}:${index}`}
            className={`kesp-assistant-metric-chip tone-${getStructuredToneClass(item.tone)}`}
          >
            <Icon name={getStructuredIconName(item.icon)} size={14} />
            {item.label && <span className="kesp-assistant-metric-label">{item.label}</span>}
            <strong>{item.value}</strong>
          </div>
        )
      )}
    </div>
  );
}

/** Renders a steps block as numbered recommendation cards. */
function AgentProfileAssistantStepsBlock({ block }: AgentProfileAssistantBlockProps) {
  if (block.type !== 'steps') {
    return null;
  }
  const densityClass = block.items.length <= 2 ? ' compact' : '';
  return (
    <div className={`kesp-assistant-steps${densityClass}`}>
      {block.items.map(
        /** Handles the callback for this operation. */
        (item, index) => (
          <div key={`${item.title}:${index}`} className="kesp-assistant-step-card">
            <span className="kesp-assistant-step-number">{index + 1}</span>
            <p>
              <strong>{item.title}</strong>
              <span>{item.body}</span>
            </p>
          </div>
        )
      )}
    </div>
  );
}

/** Renders a comparison block as a compact table. */
function AgentProfileAssistantComparisonBlock({ block }: AgentProfileAssistantBlockProps) {
  if (block.type !== 'comparison') {
    return null;
  }
  return (
    <div className="kesp-assistant-comparison" role="table">
      <div className="kesp-assistant-comparison-head" role="row">
        <span role="columnheader" />
        <strong role="columnheader">{block.leftLabel}</strong>
        <strong role="columnheader">{block.rightLabel}</strong>
      </div>
      {block.rows.map(
        /** Handles the callback for this operation. */
        (row, index) => (
          <div key={`${row.label}:${index}`} className="kesp-assistant-comparison-row" role="row">
            <span role="rowheader">{row.label}</span>
            <p role="cell">{row.left}</p>
            <p role="cell">{row.right}</p>
          </div>
        )
      )}
    </div>
  );
}

/** Renders a status block with a visible tone badge. */
function AgentProfileAssistantStatusBlock({ block }: AgentProfileAssistantBlockProps) {
  if (block.type !== 'status') {
    return null;
  }
  const toneClass = getStructuredToneClass(block.tone);
  return (
    <div className={`kesp-assistant-status-block tone-${toneClass}`}>
      <span className={`kesp-assistant-status-badge tone-${toneClass}`}>
        {block.label}
      </span>
      {block.detail && <p>{block.detail}</p>}
    </div>
  );
}

/** Renders one typed assistant response block. */
function AgentProfileAssistantStructuredBlockView({ block }: AgentProfileAssistantBlockProps) {
  switch (block.type) {
    case 'metrics':
      return <AgentProfileAssistantMetricsBlock block={block} />;
    case 'steps':
      return <AgentProfileAssistantStepsBlock block={block} />;
    case 'comparison':
      return <AgentProfileAssistantComparisonBlock block={block} />;
    case 'status':
      return <AgentProfileAssistantStatusBlock block={block} />;
    case 'text':
      return <p className="kesp-assistant-structured-text">{block.text}</p>;
    default:
      return null;
  }
}

/** Renders model-structured assistant content into dedicated visual components. */
function AgentProfileAssistantStructuredContentView({
  content,
}: AgentProfileAssistantStructuredContentProps) {
  return (
    <div className="kesp-assistant-structured">
      {content.intro && <p className="kesp-assistant-intro">{content.intro}</p>}
      {content.blocks.map(
        /** Handles the callback for this operation. */
        (block, index) => (
          <AgentProfileAssistantStructuredBlockView
            key={`${block.type}:${index}`}
            block={block}
          />
        )
      )}
      {content.outro && <p className="kesp-assistant-outro">{content.outro}</p>}
    </div>
  );
}

/** Renders the fallback plain message content for legacy chat history. */
function AgentProfileAssistantPlainContent({ message }: { message: AgentProfileAssistantChatMessage }) {
  return <>{message.content}</>;
}

/** Renders one assistant chat message with identity, timestamp, content, and references. */
function AgentProfileAssistantMessage({
  message,
  assistantName,
  userName,
  language,
  openReference,
}: AgentProfileAssistantMessageProps) {
  const isAssistant = message.role === 'assistant';
  const displayName = isAssistant ? assistantName : userName;
  const timeLabel = formatAssistantMessageTime(message.createdAtMs, language);
  return (
    <div className={getAssistantMessageClassName(message)}>
      <div className="kesp-assistant-avatar" aria-hidden="true">
        {isAssistant ? <Icon name="bulb" size={15} /> : userName.slice(0, 1).toUpperCase()}
      </div>
      <div className="kesp-assistant-msg-stack">
        <div className="kesp-assistant-msg-meta">
          <span className="kesp-assistant-msg-name">{displayName}</span>
          {isAssistant && <span className="kesp-assistant-online-dot" aria-hidden="true" />}
          {timeLabel && <time dateTime={new Date(message.createdAtMs).toISOString()}>{timeLabel}</time>}
        </div>
        <div className="kesp-assistant-bubble">
          {isAssistant && message.structuredContent ? (
            <AgentProfileAssistantStructuredContentView content={message.structuredContent} />
          ) : (
            <AgentProfileAssistantPlainContent message={message} />
          )}
        </div>
        {isAssistant && message.references && message.references.length > 0 && (
          <div className="kesp-assistant-refs">
            {message.references.map(
              /** Handles the callback for this operation. */
              (reference) => (
                <button
                  key={`${message.id}:${reference.type}:${reference.id}`}
                  type="button"
                  className={
                    'kesp-assistant-ref-chip' +
                    (reference.type === 'call' ? ' clickable' : '')
                  }
                  onClick={
                    /** Handles the onClick interaction. */
                    () => openReference(reference)
                  }
                  disabled={reference.type !== 'call'}
                  title={reference.id}
                >
                  <Pill kind="default">{reference.label}</Pill>
                </button>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Renders the animated assistant typing indicator. */
function AgentProfileAssistantTypingIndicator({ label }: { label: string }) {
  return (
    <div className="kesp-assistant-msg kesp-assistant-msg-assistant kesp-assistant-msg-typing">
      <div className="kesp-assistant-avatar" aria-hidden="true">
        <Icon name="bulb" size={15} />
      </div>
      <div className="kesp-assistant-msg-stack">
        <div className="kesp-assistant-typing" aria-label={label}>
          <span>{label}</span>
          <i aria-hidden="true" />
          <i aria-hidden="true" />
          <i aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

/** Renders the reusable assistant chat surface. */
function AgentProfileAssistantSurface({
  variant,
  autoFocus = false,
  onClose,
}: AgentProfileAssistantSurfaceProps) {
  const { t, i18n } = useTranslation();
  const { canStart } = useDemoProcessingStatus();
  const {
    salesAgentName,
    chat,
    draft,
    loading,
    sending,
    resetting,
    error,
    pendingQuestion,
    examplePrompts,
    setDraft,
    resetChat,
    sendQuestion,
    openReference,
  } = useAgentProfileAssistant();
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const hasMessages = Boolean(chat?.messages?.length);
  const inputDisabled = loading || sending || resetting || !chat || !canStart;
  const resetDisabled = loading || sending || resetting || !hasMessages;
  const assistantName = t('kesp.agent.assistant.identityName');
  const userName = t('kesp.agent.assistant.userName');

  useEffect(
    /** Handles the callback for this operation. */
    () => {
      const el = listRef.current;
      if (!el) {
        return;
      }
      el.scrollTop = el.scrollHeight;
    },
    [chat?.messages?.length, error, loading, sending]
  );

  useEffect(
    /** Handles the callback for this operation. */
    () => {
      if (!autoFocus) {
        return;
      }
      inputRef.current?.focus();
    },
    [autoFocus]
  );

  useEffect(
    /** Handles the callback for this operation. */
    () => {
      resizeAssistantTextarea(inputRef.current);
    },
    [draft]
  );

  /** Handles draft updates from either assistant surface. */
  const onDraftChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.currentTarget.value);
    resizeAssistantTextarea(event.currentTarget);
  };

  /** Handles keyboard submission from either assistant surface. */
  const onDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendQuestion();
    }
  };

  /** Fills the composer with a suggested prompt. */
  const onSuggestionClick = (prompt: string) => {
    setDraft(prompt);
    window.requestAnimationFrame(
      /** Handles the callback for this operation. */
      () => {
        inputRef.current?.focus();
        resizeAssistantTextarea(inputRef.current);
      }
    );
  };

  return (
    <div className={`kesp-assistant-surface kesp-assistant-surface-${variant}`}>
      <DemoProcessingStatus />
      <div className="kesp-assistant-header">
        <div className="kesp-assistant-header-avatar" aria-hidden="true">
          <Icon name="bulb" size={16} />
          <span />
        </div>
        <div className="kesp-assistant-heading">
          <div className="kesp-assistant-title">{assistantName}</div>
          <div className="kesp-assistant-subtitle">
            {t('kesp.agent.assistant.subtitle', { name: salesAgentName })}
          </div>
        </div>
        <div className="kesp-assistant-header-actions">
          <button
            type="button"
            className="kesp-assistant-icon-button"
            onClick={
              /** Handles the onClick interaction. */
              () => {
                void resetChat();
              }
            }
            disabled={resetDisabled}
            aria-label={t('kesp.agent.assistant.reset')}
            title={t('kesp.agent.assistant.reset')}
          >
            <Icon name="refresh" size={16} />
          </button>
          {onClose && (
            <button
              type="button"
              className="kesp-assistant-close"
              onClick={onClose}
              aria-label={t('kesp.agent.assistant.close')}
            >
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="kesp-assistant-body" ref={listRef}>
        {loading && (
          <div className="kesp-assistant-loading">{t('kesp.agent.assistant.loading')}</div>
        )}

        {!loading && !hasMessages && (
          <div className="kesp-assistant-empty">
            <div className="kesp-assistant-empty-title">{t('kesp.agent.assistant.emptyTitle')}</div>
            <p>{t('kesp.agent.assistant.emptyBody')}</p>
          </div>
        )}

        {chat?.messages?.map(
          /** Handles the callback for this operation. */
          (message) => (
            <AgentProfileAssistantMessage
              key={message.id}
              message={message}
              assistantName={assistantName}
              userName={userName}
              language={i18n.language}
              openReference={openReference}
            />
          )
        )}

        {sending && pendingQuestion && (
          <AgentProfileAssistantTypingIndicator label={t('kesp.agent.assistant.typing')} />
        )}

        {error && <div className="kesp-assistant-error">{error}</div>}
      </div>

      <div className="kesp-assistant-input">
        <div className="kesp-assistant-suggestions" aria-label={t('kesp.agent.assistant.examplesTitle')}>
          {examplePrompts.map(
            /** Handles the callback for this operation. */
            (prompt) => (
              <button
                key={prompt}
                type="button"
                className="kesp-assistant-suggestion-chip"
                onClick={
                  /** Handles the onClick interaction. */
                  () => onSuggestionClick(prompt)
                }
                disabled={inputDisabled}
              >
                {prompt}
              </button>
            )
          )}
        </div>
        <div className="kesp-assistant-composer">
        <textarea
          ref={inputRef}
          value={draft}
          placeholder={t('kesp.agent.assistant.placeholder')}
          onChange={onDraftChange}
          onKeyDown={onDraftKeyDown}
          disabled={inputDisabled}
          rows={1}
        />
        <Button
          kind="primary"
          size="sm"
          icon={<Icon name="arrow" size={14} />}
          onClick={
            /** Handles the onClick interaction. */
            () => {
              void sendQuestion();
            }
          }
          disabled={inputDisabled || draft.trim().length === 0}
        >
          {sending ? t('kesp.agent.assistant.sending') : t('kesp.agent.assistant.send')}
        </Button>
        </div>
      </div>
    </div>
  );
}

/** Renders the preserved bottom-right assistant launcher and floating panel. */
export function AgentProfileAssistantFloating() {
  const { t } = useTranslation();
  const { floatingOpen, setFloatingOpen, closeFloating } = useAgentProfileAssistant();

  return (
    <div className="kesp-assistant-root" aria-live="polite">
      {floatingOpen && (
        <div
          className="kesp-assistant-backdrop"
          onClick={closeFloating}
        />
      )}

      {floatingOpen && (
        <div className="kesp-assistant-panel" role="dialog" aria-modal="true">
          <AgentProfileAssistantSurface
            variant="floating"
            autoFocus
            onClose={closeFloating}
          />
        </div>
      )}

      <button
        type="button"
        className="kesp-assistant-fab"
        onClick={
          /** Handles the onClick interaction. */
          () => setFloatingOpen(!floatingOpen)
        }
        aria-label={t('kesp.agent.assistant.launcher')}
      >
        <Icon name="msg" size={18} />
      </button>
    </div>
  );
}

/** Renders the larger inline assistant panel for the agent profile Arvo tab. */
export function AgentProfileAssistantInline() {
  return (
    <div className="kesp-assistant-inline-card">
      <AgentProfileAssistantSurface variant="inline" />
    </div>
  );
}
