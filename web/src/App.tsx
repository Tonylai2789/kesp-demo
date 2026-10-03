import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Routes, Route, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AuthProvider } from '@/contexts/AuthContext';
import { KespDemoRedactionController } from '@/components/kesp/KespDemoRedactionController';
import { useAuth } from '@/contexts/useAuth';
import '@/i18n';

const Layout = lazy(/** Handles the callback for this operation. */() =>
  import('@/components/layout/Layout').then(/** Handles the callback for this operation. */(module) => ({ default: module.Layout }))
);
const HomePage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/HomePage').then(/** Handles the callback for this operation. */(module) => ({ default: module.HomePage }))
);
const KespLayout = lazy(/** Handles the callback for this operation. */() =>
  import('@/components/kesp/KespLayout').then(/** Handles the callback for this operation. */(module) => ({ default: module.KespLayout }))
);
const KespAnalizadorPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/AnalizadorPage').then(/** Handles the callback for this operation. */(module) => ({ default: module.AnalizadorPage }))
);
const KespManualProfilesPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/ManualProfilesPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.ManualProfilesPage,
  }))
);
const KespUnrecognizedCallsPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/UnrecognizedCallsPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.UnrecognizedCallsPage,
  }))
);
const KespInboxPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/InboxPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.InboxPage,
  }))
);
const KespLlamadasPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/LlamadasPage').then(/** Handles the callback for this operation. */(module) => ({ default: module.LlamadasPage }))
);
const KespSubirPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/SubirPage').then(/** Handles the callback for this operation. */(module) => ({ default: module.SubirPage }))
);
const KespSubirPromptSettingsPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/SubirPromptSettingsPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.SubirPromptSettingsPage,
  }))
);
const KespRuntimeErrorsPage = lazy(/** Handles the callback for this operation. */() =>
  import("@/pages/kesp/RuntimeErrorsPage").then(/** Handles the callback for this operation. */(module) => ({
    default: module.RuntimeErrorsPage,
  }))
);
const KespEmailReportsPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/EmailReportsPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.EmailReportsPage,
  }))
);
const KespShortCallsPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/ShortCallsPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.ShortCallsPage,
  }))
);
const KespShortCallDetailPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/ShortCallDetailPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.ShortCallDetailPage,
  }))
);
const KespCallDetailPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/CallDetailPage').then(/** Handles the callback for this operation. */(module) => ({ default: module.CallDetailPage }))
);
const KespCallPromptsPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/CallPromptsPage').then(/** Handles the callback for this operation. */(module) => ({ default: module.CallPromptsPage }))
);
const KespRubricCriterionPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/RubricCriterionPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.RubricCriterionPage,
  }))
);
const KespAgentPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/AgentPage').then(/** Handles the callback for this operation. */(module) => ({ default: module.AgentPage }))
);
const KespAggregateRubricCriterionPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/kesp/AggregateRubricCriterionPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.AggregateRubricCriterionPage,
  }))
);
const WeaknessDetailPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/WeaknessDetailPage').then(/** Handles the callback for this operation. */(module) => ({ default: module.WeaknessDetailPage }))
);
const LoginPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/LoginPage').then(/** Handles the callback for this operation. */(module) => ({ default: module.LoginPage }))
);
const SubsectionCritiquePage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/SubsectionCritiquePage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.SubsectionCritiquePage,
  }))
);
const CriterionDetailPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/CriterionDetailPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.CriterionDetailPage,
  }))
);
const PromptVersionsPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/PromptVersionsPage').then(/** Handles the callback for this operation. */(module) => ({
    default: module.PromptVersionsPage,
  }))
);
const ScorecardPage = lazy(/** Handles the callback for this operation. */() =>
  import('@/pages/ScorecardPage').then(/** Handles the callback for this operation. */(module) => ({ default: module.ScorecardPage }))
);

const KespUsersPage = lazy(() => import('@/pages/kesp/UsersPage').then((module) => ({ default: module.UsersPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

/** Renders the RedirectToAgent component. */
function RedirectToAgent() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? `/kesp/agent/${id}` : '/kesp/analizador'} replace />;
}

/** Renders the RedirectToCall component. */
function RedirectToCall() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? `/kesp/call/${id}` : '/kesp/llamadas'} replace />;
}

/** Renders the ProtectedApp component. */
function ProtectedApp() {
  const { user, loading, isEmailAllowed } = useAuth();

  if (loading) {
    return <AppShellFallback />;
  }

  if (!user || !isEmailAllowed) {
    return (
      <Suspense fallback={<AppShellFallback />}>
        <LoginPage />
      </Suspense>
    );
  }

  return (
    <KespDemoRedactionController>
      <BrowserRouter>
        <Suspense fallback={<AppShellFallback />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/kesp/panel" element={<Navigate to="/kesp/analizador" replace />} />
          <Route path="/kesp" element={<KespLayout />}>
            <Route index element={<KespAnalizadorPage />} />
            <Route path="analizador" element={<KespAnalizadorPage />} />
            <Route path="analizador/unrecognized" element={<KespUnrecognizedCallsPage />} />
            <Route path="manual-profiles" element={<KespManualProfilesPage />} />
            <Route path="inbox" element={<KespInboxPage />} />
            <Route path="llamadas" element={<KespLlamadasPage />} />
            <Route path="subir" element={<KespSubirPage />} />
            <Route path="subir/prompts" element={<KespSubirPromptSettingsPage />} />
            <Route path="runtime-errors" element={<KespRuntimeErrorsPage />} />
            <Route path="users" element={<KespUsersPage />} />
            <Route path="email-reports" element={<KespEmailReportsPage />} />
            <Route path="short-calls" element={<KespShortCallsPage />} />
            <Route path="short-calls/:id" element={<KespShortCallDetailPage />} />
            <Route path="call/:id" element={<KespCallDetailPage />} />
            <Route path="call/:id/prompts" element={<KespCallPromptsPage />} />
            <Route
              path="call/:id/rubric/:sectionId/:groupId/:criterionId"
              element={<KespRubricCriterionPage />}
            />
            <Route path="agent" element={<KespAgentPage />} />
            <Route path="agent/:id" element={<KespAgentPage />} />
            <Route
              path="agent/:id/rubric/:sectionId/:groupId/:criterionId"
              element={<KespAggregateRubricCriterionPage />}
            />
          </Route>

          {/* Redirect legacy top-level paths to their Kesp equivalents so old
              bookmarks land on the new UI. */}
          <Route path="call-analyzer" element={<Navigate to="/kesp/analizador" replace />} />
          <Route path="call-analyzer/:id" element={<RedirectToAgent />} />
          <Route
            path="call-analyzer/:id/patterns/:patternId/examples"
            element={<RedirectToAgent />}
          />
          <Route path="calls" element={<Navigate to="/kesp/llamadas" replace />} />
          <Route path="calls/:id" element={<RedirectToCall />} />
          <Route path="upload" element={<Navigate to="/kesp/subir" replace />} />

          {/* Legacy admin / V1-rubric-fallback paths kept under Layout. The Kesp
              call detail links into /calls/:id/scorecard for V1 feedback docs;
              prompt-versions has no Kesp surface. */}
          <Route element={<Layout />}>
            <Route path="calls/:id/prompt-versions" element={<PromptVersionsPage />} />
            <Route path="calls/:id/weaknesses/:weaknessIndex" element={<WeaknessDetailPage />} />
            <Route path="calls/:id/scorecard" element={<ScorecardPage />} />
            <Route
              path="calls/:id/scorecard/v2/:sectionId/:criterionId"
              element={<CriterionDetailPage />}
            />
            <Route
              path="calls/:id/scorecard/v2/:sectionId/:criterionId/weaknesses/:critiqueIndex"
              element={<WeaknessDetailPage />}
            />
            <Route
              path="calls/:id/scorecard/:sectionIndex/:subsectionIndex"
              element={<SubsectionCritiquePage />}
            />
            <Route
              path="calls/:id/scorecard/:sectionIndex/:subsectionIndex/weaknesses/:critiqueIndex"
              element={<WeaknessDetailPage />}
            />
          </Route>

          {/* Anything else: bounce to home so unknown legacy paths don't 404. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </KespDemoRedactionController>
  );
}

/** Renders the AppShellFallback component. */
function AppShellFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground mx-auto"></div>
        <p className="mt-2 text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

/** Renders the App component. */
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider attribute="class" defaultTheme="light" storageKey="theme">
        <AuthProvider>
          <ErrorBoundary>
            <ProtectedApp />
          </ErrorBoundary>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
