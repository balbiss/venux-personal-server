import { useState, useEffect } from "react";
import { Users, UserCheck, Smartphone, Loader2 } from "lucide-react";
import { StatCard } from "@/components/StatCard";
import { LeadsChart } from "@/components/LeadsChart";
import { motion } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { useUserSession } from "@/hooks/useUserSession";

export default function Dashboard() {
  const { tid } = useUserSession();
  const [stats, setStats] = useState({
    todayLeads: 0,
    qualifiedLeads: 0,
    activeInstances: 0
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tid) return;

    const fetchStats = async () => {
      try {
        // 1. Buscar Sessão para ver instâncias
        const { data: session } = await supabase
          .from("bot_sessions")
          .select("data")
          .eq("chat_id", tid)
          .maybeSingle();

        const instances = session?.data?.whatsapp?.instances || [];
        const instIds = instances.map((i: any) => i.id);

        if (instIds.length === 0) {
          setLoading(false);
          return;
        }

        // 2. Buscar Leads de hoje
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const { count: todayCount } = await supabase
          .from("ai_leads_tracking")
          .select("*", { count: 'exact', head: true })
          .in("instance_id", instIds)
          .gte("last_interaction", today.toISOString());

        // 3. Buscar Leads Qualificados (TRANSFERRED ou status de conversão)
        const { count: qualifiedCount } = await supabase
          .from("ai_leads_tracking")
          .select("*", { count: 'exact', head: true })
          .in("instance_id", instIds)
          .eq("status", "TRANSFERRED");

        setStats({
          todayLeads: todayCount || 0,
          qualifiedLeads: qualifiedCount || 0,
          activeInstances: instances.filter((i: any) => i.presence === "available").length
        });
      } catch (err) {
        console.error("Erro ao carregar stats:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [tid]);

  if (loading && tid) {
    return (
      <div className="flex items-center justify-center p-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
        <h1 className="text-2xl font-display font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Visão geral da sua operação</p>
      </motion.div>

      {!tid ? (
        <div className="p-10 border border-dashed rounded-xl text-center">
          <p className="text-muted-foreground">Utilize o link gerado pelo seu bot do Telegram para visualizar as estatísticas reais.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard title="Leads de Hoje" value={stats.todayLeads} icon={Users} delay={0.1} />
            <StatCard title="Leads Qualificados" value={stats.qualifiedLeads} icon={UserCheck} delay={0.2} />
            <StatCard title="Instâncias Ativas" value={stats.activeInstances} icon={Smartphone} delay={0.3} />
          </div>

          <LeadsChart />
        </>
      )}
    </div>
  );
}
