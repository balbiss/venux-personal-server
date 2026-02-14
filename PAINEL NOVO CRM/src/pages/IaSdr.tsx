import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Brain, Sparkles, Loader2, Save, Smartphone } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useUserSession } from "@/hooks/useUserSession";
import { toast } from "sonner";

export default function IaSdr() {
  const { tid } = useUserSession();
  const [sessionData, setSessionData] = useState<any>(null);
  const [selectedInstId, setSelectedInstId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Estados locais para edição
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiHumanTopics, setAiHumanTopics] = useState("");

  useEffect(() => {
    if (!tid) return;

    const fetchSession = async () => {
      try {
        const { data, error } = await supabase
          .from("bot_sessions")
          .select("data")
          .eq("telegram_id", tid)
          .maybeSingle();

        if (error) throw error;
        if (data?.data) {
          setSessionData(data.data);
          const insts = data.data.whatsapp?.instances || [];
          if (insts.length > 0) {
            setSelectedInstId(insts[0].id);
            setAiEnabled(insts[0].ai_enabled || false);
            setAiPrompt(insts[0].ai_prompt || "");
            setAiHumanTopics(insts[0].ai_human_topics || "");
          }
        }
      } catch (err: any) {
        toast.error("Erro ao carregar dados: " + err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchInstances();
  }, [tid]);

  // Atualiza estados locais quando a instância selecionada muda
  useEffect(() => {
    if (sessionData && selectedInstId) {
      const inst = sessionData.whatsapp?.instances?.find((i: any) => i.id === selectedInstId);
      if (inst) {
        setAiEnabled(inst.ai_enabled || false);
        setAiPrompt(inst.ai_prompt || "");
        setAiHumanTopics(inst.ai_human_topics || "");
      }
    }
  }, [selectedInstId, sessionData]);

  const handleSave = async () => {
    if (!tid || !selectedInstId || !sessionData) return;
    setSaving(true);

    try {
      const updatedInstances = sessionData.whatsapp.instances.map((inst: any) => {
        if (inst.id === selectedInstId) {
          return {
            ...inst,
            ai_enabled: aiEnabled,
            ai_prompt: aiPrompt,
            ai_human_topics: aiHumanTopics
          };
        }
        return inst;
      });

      const updatedData = {
        ...sessionData,
        whatsapp: {
          ...sessionData.whatsapp,
          instances: updatedInstances
        }
      };

      const { error } = await supabase
        .from("bot_sessions")
        .update({ data: updatedData })
        .eq("telegram_id", tid);

      if (error) throw error;

      setSessionData(updatedData);
      toast.success("Configurações salvas com sucesso!");
    } catch (err: any) {
      toast.error("Erro ao salvar: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!tid) {
    return (
      <div className="p-10 text-center text-muted-foreground">
        Acesse via bot do Telegram para configurar sua IA.
      </div>
    );
  }

  const instances = sessionData?.whatsapp?.instances || [];

  return (
    <div className="space-y-5 max-w-2xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <h1 className="text-2xl font-display font-bold text-foreground">Módulo IA SDR</h1>
        <p className="text-muted-foreground mt-1">Configure sua inteligência artificial de vendas</p>
      </motion.div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Smartphone className="h-4 w-4" /> Selecionar Instância
          </Label>
          <Select value={selectedInstId} onValueChange={setSelectedInstId}>
            <SelectTrigger className="bg-secondary/50 border-border/50">
              <SelectValue placeholder="Selecione uma instância" />
            </SelectTrigger>
            <SelectContent>
              {instances.map((inst: any) => (
                <SelectItem key={inst.id} value={inst.id}>
                  {inst.name} ({inst.id})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedInstId && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass-card p-6 space-y-6"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
                  <Brain className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <Label className="text-foreground font-semibold">IA SDR Ativa</Label>
                  <p className="text-xs text-muted-foreground">Ative para processar leads automaticamente</p>
                </div>
              </div>
              <Switch checked={aiEnabled} onCheckedChange={setAiEnabled} />
            </div>

            <div className="h-px bg-border" />

            <div className="space-y-3">
              <Label className="text-foreground font-medium flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                System Prompt
              </Label>
              <Textarea
                placeholder="Ex: Você é um assistente de vendas especializado..."
                className="min-h-[160px] bg-secondary/50 border-border/50 focus:border-primary/50 resize-none"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
              />
            </div>

            <div className="space-y-3">
              <Label className="text-foreground font-medium">Temas para Humano (Transbordo)</Label>
              <Input
                placeholder="Ex: preço, contrato, suporte técnico"
                className="bg-secondary/50 border-border/50 focus:border-primary/50"
                value={aiHumanTopics}
                onChange={(e) => setAiHumanTopics(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Separe os temas por vírgula. A IA irá parar quando detectar esses assuntos.
              </p>
            </div>

            <Button
              onClick={handleSave}
              disabled={saving}
              className="w-full bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity font-medium gap-2"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {saving ? "Salvando..." : "Salvar Configurações"}
            </Button>
          </motion.div>
        )}
      </div>
    </div>
  );
}
