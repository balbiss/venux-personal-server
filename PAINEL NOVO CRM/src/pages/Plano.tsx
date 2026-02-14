import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Crown, Check, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useUserSession } from "@/hooks/useUserSession";

const features = [
  "Instâncias ilimitadas",
  "IA SDR avançada com GPT-4",
  "CRM completo com automações",
  "Suporte prioritário 24/7",
  "API de integração",
  "Relatórios avançados",
  "Webhooks customizados",
  "Treinamento personalizado",
];

export default function Plano() {
  const { tid } = useUserSession();
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tid) return;

    const fetchSession = async () => {
      try {
        const { data, error } = await supabase
          .from("bot_sessions")
          .select("isVip, subscriptionExpiry")
          .eq("chat_id", tid)
          .maybeSingle();

        if (error) throw error;
        setSession(data);
      } catch (err) {
        console.error("Erro ao carregar plano:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchSession();
  }, [tid]);

  if (loading && tid) {
    return (
      <div className="flex items-center justify-center p-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const isVip = session?.isVip;
  const expiry = session?.subscriptionExpiry ? new Date(session.subscriptionExpiry).toLocaleDateString("pt-BR") : "N/A";

  return (
    <div className="space-y-5 max-w-2xl">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <h1 className="text-2xl font-display font-bold text-foreground">Meu Plano</h1>
        <p className="text-muted-foreground mt-1">Gerencie sua assinatura</p>
      </motion.div>

      {!tid ? (
        <div className="p-10 border border-dashed rounded-xl text-center">
          <p className="text-muted-foreground">Acesse via bot do Telegram para ver os detalhes da sua assinatura.</p>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="glass-card overflow-hidden relative"
        >
          {/* Gradient accent */}
          <div className="h-1 w-full bg-gradient-to-r from-primary to-accent" />

          <div className="p-8 space-y-8">
            <div className="flex items-center gap-4">
              <div className={`w-14 h-14 rounded-2xl flex items-center justify-center animate-float ${isVip ? 'bg-gradient-to-br from-primary to-accent' : 'bg-secondary'}`}>
                <Crown className={`h-7 w-7 ${isVip ? 'text-primary-foreground' : 'text-muted-foreground'}`} />
              </div>
              <div>
                <h2 className="text-xl font-display font-bold gradient-text">{isVip ? 'VIP Enterprise' : 'Plano Grátis / Expirado'}</h2>
                <p className="text-sm text-muted-foreground">
                  {isVip ? `Renovação: ${expiry}` : 'Assine para liberar todos os recursos'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {features.map((feat, i) => (
                <motion.div
                  key={feat}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.05 * i }}
                  className="flex items-center gap-2.5 text-sm"
                >
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${isVip ? 'bg-success/10' : 'bg-secondary'}`}>
                    <Check className={`h-3 w-3 ${isVip ? 'text-success' : 'text-muted-foreground'}`} />
                  </div>
                  <span className="text-foreground">{feat}</span>
                </motion.div>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <Button className="bg-gradient-to-r from-primary to-accent hover:opacity-90 transition-opacity gap-2">
                <ExternalLink className="h-4 w-4" /> Portal de Faturamento
              </Button>
              {!isVip && (
                <Button variant="secondary" className="gap-2">
                  Ver Planos
                </Button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
