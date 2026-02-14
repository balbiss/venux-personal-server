import { useState, useEffect } from "react";
import { Outlet } from "react-router-dom";
import { AppSidebar } from "./AppSidebar";
import { Menu } from "lucide-react";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 1024);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 1024);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return isMobile;
}

export function DashboardLayout() {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);

  return (
    <div className="flex min-h-screen w-full bg-background">
      <AppSidebar open={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} />
      <main className="flex-1 flex flex-col min-h-screen overflow-hidden">
        <header className="h-14 flex items-center px-6 border-b border-border/50 backdrop-blur-sm bg-background/80 sticky top-0 z-30 lg:hidden">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-2 rounded-lg hover:bg-secondary transition-colors">
            <Menu className="h-5 w-5 text-muted-foreground" />
          </button>
        </header>
        <div className="flex-1 overflow-auto px-4 py-5 lg:px-6 lg:py-6">
          <div className="mx-auto w-full max-w-[1100px]">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}
