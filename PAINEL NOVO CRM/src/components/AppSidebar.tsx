import { NavLink, useLocation } from "react-router-dom";
import { LayoutDashboard, Smartphone, Brain, Users, CreditCard, ChevronLeft, Zap } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const navItems = [
  { title: "Dashboard", path: "/", icon: LayoutDashboard },
  { title: "Minhas Instâncias", path: "/instancias", icon: Smartphone },
  { title: "Módulo IA SDR", path: "/ia-sdr", icon: Brain },
  { title: "CRM / Leads", path: "/crm", icon: Users },
  { title: "Meu Plano", path: "/plano", icon: CreditCard },
];

interface AppSidebarProps {
  open: boolean;
  onToggle: () => void;
}

export function AppSidebar({ open, onToggle }: AppSidebarProps) {
  const location = useLocation();

  return (
    <>
      {/* Mobile overlay */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-background/60 backdrop-blur-sm z-40 lg:hidden"
            onClick={onToggle}
          />
        )}
      </AnimatePresence>

      <aside
        className={`
          fixed lg:sticky top-0 left-0 z-50 h-screen
          flex flex-col bg-sidebar border-r border-sidebar-border
          transition-all duration-300 ease-out
          ${open ? "w-64 translate-x-0" : "w-0 -translate-x-full lg:w-16 lg:translate-x-0"}
        `}
      >
        {/* Logo */}
        <div className="h-14 flex items-center px-4 border-b border-sidebar-border shrink-0">
          <div className="flex items-center gap-3 overflow-hidden">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shrink-0">
              <Zap className="h-4 w-4 text-primary-foreground" />
            </div>
            {open && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="font-display font-bold text-foreground whitespace-nowrap"
              >
                ZapFlow
              </motion.span>
            )}
          </div>
          <button
            onClick={onToggle}
            className="ml-auto p-1.5 rounded-md hover:bg-sidebar-accent transition-colors hidden lg:flex"
          >
            <ChevronLeft className={`h-4 w-4 text-sidebar-foreground transition-transform duration-300 ${!open ? "rotate-180" : ""}`} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 px-3 space-y-1 overflow-hidden">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={`
                  group flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium
                  transition-all duration-200 relative overflow-hidden
                  ${isActive
                    ? "bg-primary/10 text-primary"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  }
                `}
              >
                {isActive && (
                  <motion.div
                    layoutId="activeNav"
                    className="absolute inset-0 bg-primary/10 rounded-lg"
                    transition={{ type: "spring", stiffness: 350, damping: 30 }}
                  />
                )}
                <item.icon className={`h-5 w-5 shrink-0 relative z-10 ${isActive ? "text-primary" : ""}`} />
                {open && (
                  <span className="relative z-10 whitespace-nowrap">{item.title}</span>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* Footer */}
        {open && (
          <div className="p-4 border-t border-sidebar-border">
            <div className="glass-card p-3 rounded-lg">
              <p className="text-xs text-muted-foreground">Plano Atual</p>
              <p className="text-sm font-semibold gradient-text">VIP Enterprise</p>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
