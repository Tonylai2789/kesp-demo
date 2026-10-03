import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  collection,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { useAuth } from '@/contexts/useAuth';
import { db } from '@/services/firebaseFirestore';
import type { KespInboxMessage } from '@/types/kespInbox';
import {
  dismissKespInboxMessage,
  dismissReadKespInboxMessages,
  docToKespInboxMessage,
  KESP_INBOX_COLLECTION,
  KESP_INBOX_MESSAGES_SUBCOLLECTION,
  markAllKespInboxMessagesRead,
  markKespInboxMessageRead,
} from '@/services/kespInbox';
import { describeKespInboxMessage, getKespInboxMessageHref } from '@/lib/kespInboxMessages';
import { formatKespDate } from '@/lib/kespI18n';
import { Icon } from '@/components/kesp/icons';
import { Button } from '@/components/kesp/primitives';

const INBOX_PAGE_SIZE = 200;

/** Renders the InboxPage component. */
export function InboxPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [liveMessages, setLiveMessages] = useState<KespInboxMessage[]>([]);
  const [liveCursor, setLiveCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [olderMessages, setOlderMessages] = useState<KespInboxMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const language = i18n.resolvedLanguage;

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) return /** Handles the callback for this operation. */ () => undefined;

    setLoading(true);
    setOlderMessages([]);
    setOlderCursor(null);
    setHasMore(false);

    /** Calls Firebase Firestore to subscribe to the newest active inbox messages for the full inbox page. */
    const liveQuery = query(
      collection(db, KESP_INBOX_COLLECTION, user.uid, KESP_INBOX_MESSAGES_SUBCOLLECTION),
      where('dismissedAt', '==', null),
      orderBy('createdAt', 'desc'),
      limit(INBOX_PAGE_SIZE)
    );

    return onSnapshot(
      liveQuery,
      /** Handles the callback for this operation. */
      (snapshot) => {
        const nextMessages = snapshot.docs
          .map(/** Handles the callback for this operation. */(docSnap) => docToKespInboxMessage(docSnap.id, docSnap.data()))
          .filter(/** Handles the callback for this operation. */(message): message is KespInboxMessage => Boolean(message));
        setLiveMessages(nextMessages);
        setLiveCursor(snapshot.docs[snapshot.docs.length - 1] ?? null);
        setHasMore(snapshot.size === INBOX_PAGE_SIZE);
        setLoading(false);
      },
      /** Handles the callback for this operation. */
      (error) => {
        console.error('KESP inbox page subscription error:', error);
        setLiveMessages([]);
        setLiveCursor(null);
        setHasMore(false);
        setLoading(false);
      }
    );
  }, [user?.uid]);

  const messages = useMemo(/** Handles the callback for this operation. */() => {
    const byId = new Map<string, KespInboxMessage>();
    olderMessages.forEach(/** Handles the callback for this operation. */(message) => byId.set(message.id, message));
    liveMessages.forEach(/** Handles the callback for this operation. */(message) => byId.set(message.id, message));
    return Array.from(byId.values()).sort(
      /** Handles the callback for this operation. */ (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }, [liveMessages, olderMessages]);

  const unreadMessages = useMemo(
    /** Handles the callback for this operation. */ () => messages.filter((message) => !message.readAt),
    [messages]
  );
  const readMessages = useMemo(
    /** Handles the callback for this operation. */ () => messages.filter((message) => Boolean(message.readAt)),
    [messages]
  );

  const handleMessageClick = /** Handles the handleMessageClick interaction. */ async (
    message: KespInboxMessage
  ) => {
    if (!user?.uid) return;
    try {
      if (!message.readAt) {
        // Firebase Firestore: marks this inbox message as read before navigating to its destination.
        await markKespInboxMessageRead({ userId: user.uid, messageId: message.id });
      }
    } catch (error) {
      console.error('Failed to mark inbox message read:', error);
    }

    const href = getKespInboxMessageHref(message);
    if (href) {
      navigate(href);
    }
  };

  const handleMarkRead = /** Handles the handleMarkRead interaction. */ async (
    message: KespInboxMessage
  ) => {
    if (!user?.uid) return;
    if (message.readAt) return;
    try {
      // Firebase Firestore: marks a single inbox message as read from the full inbox page.
      await markKespInboxMessageRead({ userId: user.uid, messageId: message.id });
      const now = new Date();
      setOlderMessages(
        /** Handles the callback for this operation. */
        (prev) =>
          prev.map((existing) =>
            existing.id === message.id
              ? { ...existing, readAt: now, updatedAt: now }
              : existing
          )
      );
    } catch (error) {
      console.error('Failed to mark inbox message read:', error);
      toast.error(t('kesp.inbox.toasts.markReadError'));
    }
  };

  const handleDismissMessage = /** Handles the handleDismissMessage interaction. */ async (
    message: KespInboxMessage
  ) => {
    if (!user?.uid) return;
    if (!message.readAt) return;
    try {
      // Firebase Firestore: dismisses this read inbox message for the signed-in user.
      await dismissKespInboxMessage({ userId: user.uid, messageId: message.id });
      setLiveMessages(
        /** Handles the callback for this operation. */
        (prev) => prev.filter((existing) => existing.id !== message.id)
      );
      setOlderMessages(
        /** Handles the callback for this operation. */
        (prev) => prev.filter((existing) => existing.id !== message.id)
      );
      toast.success(t('kesp.inbox.toasts.dismissSuccess'));
    } catch (error) {
      console.error('Failed to dismiss inbox message:', error);
      toast.error(t('kesp.inbox.toasts.dismissError'));
    }
  };

  const handleLoadMore = /** Handles the handleLoadMore interaction. */ async () => {
    if (!user?.uid) return;
    if (loadingMore) return;
    const cursor = olderCursor ?? liveCursor;
    if (!cursor) return;

    setLoadingMore(true);
    try {
      /** Calls Firebase Firestore to fetch an additional page of older inbox messages for the full inbox page. */
      const olderQuery = query(
        collection(db, KESP_INBOX_COLLECTION, user.uid, KESP_INBOX_MESSAGES_SUBCOLLECTION),
        where('dismissedAt', '==', null),
        orderBy('createdAt', 'desc'),
        startAfter(cursor),
        limit(INBOX_PAGE_SIZE)
      );
      const snapshot = await getDocs(olderQuery);
      const nextMessages = snapshot.docs
        .map(/** Handles the callback for this operation. */(docSnap) => docToKespInboxMessage(docSnap.id, docSnap.data()))
        .filter(/** Handles the callback for this operation. */(message): message is KespInboxMessage => Boolean(message));
      setOlderMessages(/** Handles the callback for this operation. */(prev) => [...prev, ...nextMessages]);
      setOlderCursor(snapshot.docs[snapshot.docs.length - 1] ?? null);
      setHasMore(snapshot.size === INBOX_PAGE_SIZE);
    } catch (error) {
      console.error('Failed to load more inbox messages:', error);
      toast.error(t('kesp.inbox.toasts.loadMoreError'));
    } finally {
      setLoadingMore(false);
    }
  };

  const handleMarkAllRead = /** Handles the handleMarkAllRead interaction. */ async () => {
    if (!user?.uid) return;
    try {
      // Firebase Firestore: marks all active inbox messages as read for the signed-in user.
      await markAllKespInboxMessagesRead({ userId: user.uid });
      const now = new Date();
      setOlderMessages(
        /** Handles the callback for this operation. */
        (prev) =>
          prev.map((message) =>
            message.readAt ? message : { ...message, readAt: now, updatedAt: now }
          )
      );
      toast.success(t('kesp.inbox.toasts.markAllReadSuccess'));
    } catch (error) {
      console.error('Failed to mark all inbox messages read:', error);
      toast.error(t('kesp.inbox.toasts.markAllReadError'));
    }
  };

  const handleDismissReadMessages = /** Handles the handleDismissReadMessages interaction. */ async () => {
    if (!user?.uid) return;
    if (readMessages.length === 0) return;
    try {
      // Firebase Firestore: dismisses all active read inbox messages for the signed-in user.
      await dismissReadKespInboxMessages({ userId: user.uid });
      setLiveMessages(
        /** Handles the callback for this operation. */
        (prev) => prev.filter((message) => !message.readAt)
      );
      setOlderMessages(
        /** Handles the callback for this operation. */
        (prev) => prev.filter((message) => !message.readAt)
      );
      toast.success(t('kesp.inbox.toasts.dismissReadSuccess'));
    } catch (error) {
      console.error('Failed to dismiss read inbox messages:', error);
      toast.error(t('kesp.inbox.toasts.dismissReadError'));
    }
  };

  /** Documents the renderMessageItem behavior. */
  const renderMessageItem = (message: KespInboxMessage, isUnread: boolean) => {
    const description = describeKespInboxMessage(message, t);
    return (
      <div
        key={message.id}
        className={`kesp-inbox-page-item kesp-inbox-item${isUnread ? ' kesp-inbox-item-unread' : ''}`}
      >
        <button
          type="button"
          className="kesp-inbox-page-row"
          onClick={/** Handles the onClick interaction. */ () => handleMessageClick(message)}
        >
          <div className="kesp-inbox-item-body">
            <div className="kesp-inbox-item-title">{description.title}</div>
            <div className="kesp-inbox-item-text">{description.body}</div>
            <div className="kesp-inbox-item-meta">
              {formatKespDate(message.createdAt, language, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </div>
          </div>
        </button>
        {isUnread ? (
          <button
            type="button"
            className="kesp-inbox-mark-read"
            title={t('kesp.inbox.markRead')}
            aria-label={t('kesp.inbox.markRead')}
            onClick={/** Handles the onClick interaction. */ (event) => {
              event.preventDefault();
              event.stopPropagation();
              handleMarkRead(message);
            }}
          >
            <Icon name="check" size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="kesp-inbox-mark-read kesp-inbox-dismiss"
            title={t('kesp.inbox.dismiss')}
            aria-label={t('kesp.inbox.dismiss')}
            onClick={/** Handles the onClick interaction. */ (event) => {
              event.preventDefault();
              event.stopPropagation();
              handleDismissMessage(message);
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
    );
  };

  return (
    <main className="main" style={{ maxWidth: 920 }}>
      <div className="page-head">
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 className="page-title">{t('kesp.inbox.pageTitle')}</h1>
          <div className="row" style={{ gap: 8 }}>
            <Button
              kind="soft"
              size="sm"
              disabled={!user?.uid}
              onClick={handleMarkAllRead}
            >
              {t('kesp.inbox.markAllRead')}
            </Button>
            <Button
              kind="ghost"
              size="sm"
              disabled={!user?.uid || readMessages.length === 0}
              onClick={handleDismissReadMessages}
            >
              {t('kesp.inbox.dismissRead')}
            </Button>
          </div>
        </div>
        <p className="page-sub">{t('kesp.inbox.pageSubtitle')}</p>
        <div className="row" style={{ justifyContent: 'flex-start', marginTop: 12 }}>
          <Button kind="ghost" size="sm" onClick={/** Handles the onClick interaction. */ () => navigate('/kesp/analizador')}>
            {t('kesp.inbox.backToAnalyzer')}
          </Button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row row-between" style={{ marginBottom: 10 }}>
          <h3 className="card-h">{t('kesp.inbox.sections.unread', { count: unreadMessages.length })}</h3>
        </div>

        {loading ? (
          <div className="muted">{t('kesp.inbox.loading')}</div>
        ) : unreadMessages.length === 0 ? (
          <div className="muted">{t('kesp.inbox.emptyUnread')}</div>
        ) : (
          <div className="kesp-inbox-page-list">
            {unreadMessages.map(/** Handles the callback for this operation. */(message) => renderMessageItem(message, true))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="row row-between" style={{ marginBottom: 10 }}>
          <h3 className="card-h">{t('kesp.inbox.sections.read', { count: readMessages.length })}</h3>
        </div>

        {loading ? (
          <div className="muted">{t('kesp.inbox.loading')}</div>
        ) : readMessages.length === 0 ? (
          <div className="muted">{t('kesp.inbox.emptyRead')}</div>
        ) : (
          <div className="kesp-inbox-page-list">
            {readMessages.map(/** Handles the callback for this operation. */(message) => renderMessageItem(message, false))}
          </div>
        )}

        {!loading && hasMore && (
          <div style={{ marginTop: 14 }}>
            <Button kind="ghost" size="sm" disabled={loadingMore || !user?.uid} onClick={handleLoadMore}>
              {loadingMore ? t('kesp.inbox.loadingMore') : t('kesp.inbox.loadMore')}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
