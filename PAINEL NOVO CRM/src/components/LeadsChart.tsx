import { motion } from "framer-motion";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const data = [
  { name: "Seg", leads: 24, qualificados: 12 },
  { name: "Ter", leads: 35, qualificados: 18 },
  { name: "Qua", leads: 28, qualificados: 22 },
  { name: "Qui", leads: 42, qualificados: 28 },
  { name: "Sex", leads: 38, qualificados: 32 },
  { name: "Sáb", leads: 20, qualificados: 15 },
  { name: "Dom", leads: 15, qualificados: 10 },
];

export function LeadsChart() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.3 }}
      className="glass-card p-5"
    >
      <h3 className="font-display font-semibold text-foreground text-sm mb-4">Performance de Leads</h3>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id="leadGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(230, 80%, 65%)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="hsl(230, 80%, 65%)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="qualGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(270, 60%, 60%)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="hsl(270, 60%, 60%)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(225, 15%, 18%)" />
          <XAxis dataKey="name" stroke="hsl(215, 15%, 55%)" fontSize={12} />
          <YAxis stroke="hsl(215, 15%, 55%)" fontSize={12} />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(225, 20%, 12%)",
              border: "1px solid hsl(225, 15%, 22%)",
              borderRadius: "0.75rem",
              color: "hsl(210, 20%, 95%)",
              backdropFilter: "blur(12px)",
            }}
          />
          <Area type="monotone" dataKey="leads" stroke="hsl(230, 80%, 65%)" fill="url(#leadGrad)" strokeWidth={2} name="Leads" />
          <Area type="monotone" dataKey="qualificados" stroke="hsl(270, 60%, 60%)" fill="url(#qualGrad)" strokeWidth={2} name="Qualificados" />
        </AreaChart>
      </ResponsiveContainer>
    </motion.div>
  );
}
