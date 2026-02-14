import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Smartphone, Wifi, WifiOff, Settings, RotateCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useUserSession } from "@/hooks/useUserSession";
import { toast } from "sonner";

export default function Instancias() {
  const { tid } = useUserSession();
  const [instances, setInstances] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tid) return;

    const fetchInstances = async () => {
      try {
        const { data, error } = await supabase
          .from("bot_sessions")
          .select("data")
          .eq("chat_id", tid)
          .maybeSingle();

        if (error) throw error;

        if (data?.data?.whatsapp?.instances) {
          setInstances(data.data.whatsapp.instances);
        }
      } catch (err: any) {
        toast.error("Erro ao carregar instâncias: " + err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchInstances();

    // Inscrição em tempo real para mudanças na sessão
    const channel = supabase
      .channel(`session-${tid}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "bot_sessions", filter: `chat_id=eq.${tid}` },
        (payload: any) => {
          if (payload.new?.data?.whatsapp?.instances) {
            setInstances(payload.new.data.whatsapp.instances);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tid]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!tid) {
    return (
      <div className="p-10 text-center">
        <p className="text-muted-foreground">Utilize o acesso via Bot do Telegram para visualizar suas instâncias.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <h1 className="text-2xl font-display font-bold text-foreground">Minhas Instâncias</h1>
        <p className="text-muted-foreground mt-1">Gerencie suas conexões WhatsApp</p>
      </motion.div>

      {instances.length === 0 ? (
        <div className="p-10 border border-dashed rounded-xl text-center">
          <p className="text-muted-foreground">Nenhuma instância conectada.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {instances.map((inst, i) => (
            <motion.div
              key={inst.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              className="glass-card-hover p-5"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                    <Smartphone className="h-6 w-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-display font-semibold text-foreground">{inst.name}</h3>
                    <p className="text-sm text-muted-foreground mt-0.5">{inst.id}</p>
                  </div>
                </div>
                <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${inst.presence === "available"
                  ? "bg-success/10 text-success"
                  : "bg-destructive/10 text-destructive"
                  }`}>
                  {inst.presence === "available" ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                  {inst.presence === "available" ? "Online" : "Offline / Ocupado"}
                </div>
              </div>
              <div className="flex gap-2 mt-5">
                <Button size="sm" variant="secondary" className="gap-2">
                  <Settings className="h-3.5 w-3.5" /> Gerenciar
                </Button>
                <Button size="sm" variant="ghost" className="gap-2">
                  <RotateCw className="h-3.5 w-3.5" /> Reconectar
                </Button>
              </div>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
