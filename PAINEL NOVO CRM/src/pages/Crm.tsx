import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Search, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useUserSession } from "@/hooks/useUserSession";

const statusColors: Record<string, string> = {
  "TRANSFERRED": "bg-success/10 text-success",
  "HUMAN_ACTIVE": "bg-warning/10 text-warning",
  "AI_SENT": "bg-primary/10 text-primary",
  "RESPONDED": "bg-accent/10 text-accent",
  "NUDGED": "bg-indigo-500/10 text-indigo-400",
};

const statusLabels: Record<string, string> = {
  "TRANSFERRED": "Qualificado",
  "HUMAN_ACTIVE": "Intervenção",
  "AI_SENT": "IA Respondeu",
  "RESPONDED": "Lead Respondeu",
  "NUDGED": "Nudge Enviado",
};

export default function Crm() {
  const { tid } = useUserSession();
  const [leads, setLeads] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");

  useEffect(() => {
    if (!tid) return;

    const fetchLeads = async () => {
      try {
        // 1. Pegar instâncias do usuário
        const { data: session } = await supabase
          .from("bot_sessions")
          .select("data")
          .eq("chat_id", tid)
          .maybeSingle();

        const instIds = session?.data?.whatsapp?.instances?.map((i: any) => i.id) || [];
        if (instIds.length === 0) {
          setLoading(false);
          return;
        }

        // 2. Buscar leads dessas instâncias
        const { data: leadsData, error } = await supabase
          .from("ai_leads_tracking")
          .select("*")
          .in("instance_id", instIds)
          .order("last_interaction", { ascending: false });

        if (error) throw error;
        setLeads(leadsData || []);
      } catch (err) {
        console.error("Erro ao carregar leads:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchLeads();
  }, [tid]);

  const filteredLeads = leads.filter(lead =>
    lead.lead_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    lead.chat_id?.includes(searchTerm)
  );

  if (loading && tid) {
    return (
      <div className="flex items-center justify-center p-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <h1 className="text-2xl font-display font-bold text-foreground">CRM / Leads</h1>
        <p className="text-muted-foreground mt-1">Gerencie seus leads qualificados</p>
      </motion.div>

      {!tid ? (
        <div className="p-10 border border-dashed rounded-xl text-center">
          <p className="text-muted-foreground">Utilize o link gerado pelo seu bot do Telegram para gerenciar seus leads.</p>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="glass-card overflow-hidden"
        >
          <div className="p-4 border-b border-border/50">
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome ou número..."
                className="pl-10 bg-secondary/50 border-border/50"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Lead</th>
                  <th className="text-left p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Número</th>
                  <th className="text-left p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="text-left p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Última Interação</th>
                  <th className="text-left p-4 text-xs font-medium text-muted-foreground uppercase tracking-wider">Instância</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeads.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-10 text-center text-muted-foreground">Nenhum lead encontrado.</td>
                  </tr>
                ) : (
                  filteredLeads.map((lead, i) => (
                    <motion.tr
                      key={lead.id || lead.chat_id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.05 * i }}
                      className="border-b border-border/30 hover:bg-secondary/30 transition-colors cursor-pointer"
                    >
                      <td className="p-4 font-medium text-foreground">{lead.lead_name || "Sem Nome"}</td>
                      <td className="p-4 text-sm text-muted-foreground">{lead.chat_id.split("@")[0]}</td>
                      <td className="p-4">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[lead.status] || "bg-secondary text-foreground"}`}>
                          {statusLabels[lead.status] || lead.status}
                        </span>
                      </td>
                      <td className="p-4 text-sm text-muted-foreground">
                        {new Date(lead.last_interaction).toLocaleString("pt-BR")}
                      </td>
                      <td className="p-4 text-sm text-muted-foreground">{lead.instance_id}</td>
                    </motion.tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}
    </div>
  );
}
