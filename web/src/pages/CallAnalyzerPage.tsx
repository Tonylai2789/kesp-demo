import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Trash2, UserRoundSearch } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { createAgentAnalysis, subscribeToAgentAnalyses } from '@/services/agentAnalyses';
import { deleteAgentAnalysis } from '@/services/functions';
import { useAuth } from '@/contexts/useAuth';
import type { AgentAnalysis } from '@/types';

/** Renders the CallAnalyzerPage component. */
export function CallAnalyzerPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [agentAnalyses, setAgentAnalyses] = useState<AgentAnalysis[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<AgentAnalysis | null>(null);
  const [salesAgentName, setSalesAgentName] = useState('');

  useEffect(/** Handles the callback for this operation. */() => {
    if (!user?.uid) {
      return undefined;
    }


    const unsubscribe = subscribeToAgentAnalyses(user.uid, /** Handles the callback for this operation. */(nextAgentAnalyses) => {
      setAgentAnalyses(nextAgentAnalyses);
      setLoading(false);
    });

    return /** Handles the callback for this operation. */ () => unsubscribe();
  }, [user?.uid]);

  const handleCreate = /** Handles the handleCreate interaction. */ async () => {
    if (!user?.uid) return;

    const trimmedName = salesAgentName.trim();

    if (!trimmedName) {
      toast.error(t('callAnalyzer.create.validation'));
      return;
    }

    setCreating(true);
    try {
      const agentAnalysisId = await createAgentAnalysis({
        uploadedBy: user.uid,
        salesAgentName: trimmedName,
      });
      toast.success(t('callAnalyzer.create.success'));
      setSalesAgentName('');
      navigate(`/call-analyzer/${agentAnalysisId}`);
    } catch (error) {
      console.error('Failed to create agent analysis:', error);
      toast.error(t('callAnalyzer.create.error'));
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = /** Handles the handleDelete interaction. */ async () => {
    if (!agentToDelete) {
      return;
    }

    setDeleting(true);
    try {
      await deleteAgentAnalysis(agentToDelete.id);
      toast.success(t('callAnalyzer.delete.success'));
      setAgentToDelete(null);
    } catch (error) {
      console.error('Failed to delete agent analysis:', error);
      toast.error(t('callAnalyzer.delete.error'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('callAnalyzer.title')}</h1>
        <p className="text-muted-foreground mt-1">{t('callAnalyzer.description')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('callAnalyzer.create.title')}</CardTitle>
          <CardDescription>{t('callAnalyzer.create.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="sales-agent-name">
                {t('callAnalyzer.create.agentName')}
              </label>
              <Input
                id="sales-agent-name"
                value={salesAgentName}
                onChange={/** Handles the onChange interaction. */ (event) => setSalesAgentName(event.target.value)}
                placeholder={t('callAnalyzer.create.agentNamePlaceholder')}
                disabled={creating}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="sales-agent-generated-id">
                {t('callAnalyzer.create.agentId')}
              </label>
              <Input
                id="sales-agent-generated-id"
                value={t('callAnalyzer.create.agentIdGeneratedValue')}
                disabled
              />
            </div>
          </div>

          <Button onClick={handleCreate} disabled={creating}>
            {creating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('callAnalyzer.create.creating')}
              </>
            ) : (
              <>
                <Plus className="h-4 w-4 mr-2" />
                {t('callAnalyzer.create.button')}
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <h2 className="text-xl font-semibold">{t('callAnalyzer.list.title')}</h2>

        {loading ? (
          <div className="flex items-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            {t('common.loading')}
          </div>
        ) : agentAnalyses.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">
              <UserRoundSearch className="mx-auto h-10 w-10 mb-3" />
              <p>{t('callAnalyzer.list.empty')}</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {agentAnalyses.map(/** Handles the callback for this operation. */(agentAnalysis) => (
              <Card key={agentAnalysis.id}>
                <CardHeader>
                  <CardTitle className="text-lg">{agentAnalysis.salesAgentName}</CardTitle>
                  <CardDescription>{agentAnalysis.salesAgentId}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="text-sm text-muted-foreground">
                    {t('callAnalyzer.list.status')}: {agentAnalysis.status}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {t('callAnalyzer.list.updatedAt')}:{' '}
                    {agentAnalysis.updatedAt.toLocaleString()}
                  </div>
                  <div className="flex gap-2">
                    <Button asChild variant="outline">
                      <Link to={`/call-analyzer/${agentAnalysis.id}`}>
                        {t('callAnalyzer.list.open')}
                      </Link>
                    </Button>
                    <Button
                      variant="destructive"
                      size="icon"
                      className="h-8 w-8"
                      onClick={/** Handles the onClick interaction. */ () => setAgentToDelete(agentAnalysis)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={Boolean(agentToDelete)} onOpenChange={/** Handles the onOpenChange interaction. */ (open) => !open && setAgentToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('callAnalyzer.delete.confirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('callAnalyzer.delete.confirmMessage', {
                salesAgentName: agentToDelete?.salesAgentName ?? '',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={/** Handles the onClick interaction. */ () => setAgentToDelete(null)}
              disabled={deleting}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              {t('callAnalyzer.delete.button')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
