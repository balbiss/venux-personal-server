import React, { useState, useEffect } from 'react';
import {
  Users,
  MessageSquare,
  BarChart3,
  Settings,
  LayoutDashboard,
  TrendingUp,
  CheckCircle2,
  UserPlus,
  LogOut,
  Send,
  FileDown,
  RefreshCw,
  Search,
  Lock,
  ChevronRight
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import { supabase } from './supabase';

export default function App() {
  const [user, setUser] = useState(null);
  const [loginId, setLoginId] = useState('');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, qualified: 0, conversion: 0, activeBrokers: 0 });
  const [chartData, setChartData] = useState([]);
  const [pieData, setPieData] = useState([]);
  const [brokers, setBrokers] = useState([]);
  const [instances, setInstances] = useState([]);
  const [selectedInstId, setSelectedInstId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [saving, setSaving] = useState(false);

  // V1.265: Autenticação persistente
  useEffect(() => {
    const savedUser = localStorage.getItem('venux_user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
    } else {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      fetchInitialData();
    }
  }, [user]);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!loginId) return;
    setLoading(true);

    try {
      // Verifica se o chat_id existe no banco
      const { data, error } = await supabase
        .from('bot_sessions')
        .select('chat_id')
        .eq('chat_id', loginId)
        .single();

      if (data) {
        const userData = { id: data.chat_id };
        localStorage.setItem('venux_user', JSON.stringify(userData));
        setUser(userData);
      } else {
        alert("❌ Telegram ID não encontrado. Use o ID enviado pelo bot.");
      }
    } catch (err) {
      alert("❌ Erro ao validar login.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('venux_user');
    setUser(null);
    setLoading(false);
  };

  const fetchInitialData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      // 1. Buscar Leads filtrados pelo owner
      const { data: leads } = await supabase
        .from('ai_leads_tracking')
        .select('*')
        .eq('owner_chat_id', user.id);

      if (leads) {
        const qualified = leads.filter(l => l.status === 'TRANSFERRED').length;
        const total = leads.length;
        setStats(prev => ({
          ...prev,
          total,
          qualified,
          conversion: total > 0 ? ((qualified / total) * 100).toFixed(1) : 0
        }));

        setPieData([
          { name: 'Qualificados', value: leads.filter(l => l.status === 'TRANSFERRED').length, color: '#3b82f6' },
          { name: 'Em Atendimento', value: leads.filter(l => l.status === 'AI_SENT').length, color: '#10b981' },
          { name: 'Aguardando', value: leads.filter(l => l.status === 'RESPONDED').length, color: '#f59e0b' },
        ]);

        const last7Days = [...Array(7)].map((_, i) => {
          const d = new Date();
          d.setDate(d.getDate() - i);
          return d.toISOString().split('T')[0];
        }).reverse();

        const dailyData = last7Days.map(date => {
          const dayLeads = leads.filter(l => l.last_interaction?.startsWith(date));
          return {
            name: date.split('-').slice(1).join('/'),
            leads: dayLeads.length,
            qualified: dayLeads.filter(l => l.status === 'TRANSFERRED').length
          };
        });
        setChartData(dailyData);
      }

      // 2. Buscar Corretores filtrados
      const { data: brokersList } = await supabase
        .from('real_estate_brokers')
        .select('*')
        .eq('owner_chat_id', user.id);
      setBrokers(brokersList || []);
      setStats(prev => ({ ...prev, activeBrokers: brokersList?.length || 0 }));

      // 3. Buscar Instâncias e Prompt do usuário logado
      const { data: session } = await supabase
        .from('bot_sessions')
        .select('*')
        .eq('chat_id', user.id)
        .single();

      if (session) {
        const insts = session.data?.whatsapp?.instances || [];
        const mappedInsts = insts.map(i => ({ ...i, owner_chat_id: session.chat_id }));
        setInstances(mappedInsts);
        if (mappedInsts.length > 0) {
          setSelectedInstId(mappedInsts[0].id);
          setPrompt(mappedInsts[0].ai_prompt || '');
        }
      }

    } catch (e) {
      console.error("Erro ao carregar dados:", e);
    } finally {
      setLoading(false);
    }
  };

  const savePrompt = async () => {
    if (!selectedInstId || !user) return;
    setSaving(true);
    try {
      const { data: sessionData } = await supabase
        .from('bot_sessions')
        .select('data')
        .eq('chat_id', user.id)
        .single();

      if (sessionData) {
        const updatedData = { ...sessionData.data };
        const instIndex = updatedData.whatsapp.instances.findIndex(i => i.id === selectedInstId);
        if (instIndex !== -1) {
          updatedData.whatsapp.instances[instIndex].ai_prompt = prompt;
          await supabase
            .from('bot_sessions')
            .update({ data: updatedData })
            .eq('chat_id', user.id);

          alert("✅ Prompt atualizado!");
        }
      }
    } catch (e) {
      alert("❌ Erro ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  // TELA DE LOGIN
  if (!user && !loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-[#0a0a0a] p-6">
        <div className="max-w-md w-full glass-card p-10 space-y-8 border-white/5">
          <div className="text-center space-y-2">
            <h1 className="text-4xl font-black bg-gradient-to-r from-blue-400 to-accent bg-clip-text text-transparent italic tracking-tighter">
              VENUX AI
            </h1>
            <p className="text-white/30 text-[10px] uppercase tracking-[4px]">SDR Central Dashboard</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-bold text-white/40 ml-1">DIGITE SEU TELEGRAM ID</label>
              <div className="relative">
                <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" size={18} />
                <input
                  type="text"
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  placeholder="Ex: 5829103..."
                  className="w-full bg-black/40 border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-sm focus:border-primary/50 outline-none transition-all placeholder:text-white/10"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-primary hover:bg-blue-600 py-4 rounded-2xl font-black text-sm transition-all flex items-center justify-center gap-2 group shadow-xl shadow-primary/20"
            >
              ACESSAR PAINEL
              <ChevronRight size={18} className="group-hover:translate-x-1 transition-transform" />
            </button>
          </form>

          <p className="text-center text-[10px] text-white/20">
            Acesso exclusivo para administradores cadastrados no bot.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-background">
        <RefreshCw className="animate-spin text-primary" size={40} />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Sidebar - Mais compacta */}
      <aside className="w-56 border-r border-white/5 bg-black/20 flex flex-col">
        <div className="p-6">
          <h1 className="text-xl font-black bg-gradient-to-r from-blue-400 to-accent bg-clip-text text-transparent italic tracking-tight">
            VENUX AI
          </h1>
        </div>

        <nav className="flex-1 px-3 space-y-1.5 py-4">
          <NavItem
            icon={<LayoutDashboard size={18} />}
            label="Dashboard"
            active={activeTab === 'dashboard'}
            onClick={() => setActiveTab('dashboard')}
          />
          <NavItem
            icon={<Settings size={18} />}
            label="IA SDR"
            active={activeTab === 'ia'}
            onClick={() => setActiveTab('ia')}
          />
          <NavItem
            icon={<Users size={18} />}
            label="Corretores"
            active={activeTab === 'brokers'}
            onClick={() => setActiveTab('brokers')}
          />
        </nav>

        <div className="p-3 border-t border-white/5">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 text-white/30 hover:text-white transition-colors w-full p-2.5 rounded-xl text-xs font-bold uppercase tracking-wider"
          >
            <LogOut size={16} />
            <span>Sair</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-6 lg:p-10">
        {activeTab === 'dashboard' && (
          <div className="space-y-8 max-w-6xl mx-auto">
            <header className="flex justify-between items-end">
              <div>
                <h2 className="text-2xl font-extrabold tracking-tight">Painel de Controle</h2>
                <p className="text-white/40 text-xs">Acompanhamento em tempo real da conta {user?.id}.</p>
              </div>
              <button onClick={fetchInitialData} className="p-2 hover:bg-white/5 rounded-full transition-colors">
                <RefreshCw size={18} className="text-white/20" />
              </button>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <StatCard title="Leads Totais" value={stats.total} icon={<MessageSquare className="text-blue-400" size={18} />} />
              <StatCard title="Qualificados" value={stats.qualified} icon={<CheckCircle2 className="text-success" size={18} />} />
              <StatCard title="Conversão" value={`${stats.conversion}%`} icon={<TrendingUp className="text-accent" size={18} />} />
              <StatCard title="Corretores" value={stats.activeBrokers} icon={<Users size={18} />} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div className="lg:col-span-2 glass-card p-6 border-white/5">
                <h3 className="text-sm font-bold mb-6 flex items-center gap-2 text-white/60">
                  <BarChart3 size={16} className="text-primary" />
                  ATIVIDADE DA SEMANA
                </h3>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                    <XAxis dataKey="name" stroke="#ffffff20" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#ffffff20" fontSize={10} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px', color: '#fff', fontSize: '12px' }}
                    />
                    <Line type="smooth" dataKey="leads" stroke="#3b82f6" strokeWidth={2} dot={false} name="Total" />
                    <Line type="smooth" dataKey="qualified" stroke="#10b981" strokeWidth={2} dot={false} name="Qualificados" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="glass-card p-6 flex flex-col border-white/5">
                <h3 className="text-sm font-bold mb-6 text-white/60 uppercase">Distribuição</h3>
                <div className="flex-1 flex items-center justify-center">
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={pieData} innerRadius={55} outerRadius={75} paddingAngle={4} dataKey="value">
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '10px' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2 mt-4">
                  {pieData.map(item => (
                    <div key={item.name} className="flex justify-between text-[10px]">
                      <span className="text-white/40 flex items-center gap-2 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: item.color }}></span>
                        {item.name}
                      </span>
                      <span className="font-bold">{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'ia' && (
          <div className="space-y-8 max-w-4xl mx-auto">
            <header>
              <h2 className="text-2xl font-extrabold tracking-tight">Cérebro da Operação</h2>
              <p className="text-white/40 text-xs">Configure como a IA deve interagir com seus leads.</p>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
              <div className="lg:col-span-1 space-y-4">
                <div className="glass-card p-4 border-white/5">
                  <label className="text-[9px] font-black text-white/30 uppercase tracking-[2px] mb-2 block">Número Conectado</label>
                  <select
                    className="w-full bg-black/40 border border-white/10 rounded-xl p-2.5 text-xs outline-none focus:border-primary transition-all cursor-pointer"
                    value={selectedInstId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setSelectedInstId(id);
                      setPrompt(instances.find(i => i.id === id)?.ai_prompt || '');
                    }}
                  >
                    {instances.map(inst => (
                      <option key={inst.id} value={inst.id} className="bg-[#1a1a1a]">{inst.name}</option>
                    ))}
                  </select>
                </div>

                <div className="glass-card p-5 border-l-2 border-primary bg-primary/5">
                  <p className="text-[11px] text-white/60 leading-relaxed italic">
                    "Instruções claras geram conversões altas. Lembre de definir o tom de voz do corretor."
                  </p>
                </div>
              </div>

              <div className="lg:col-span-3 glass-card p-6 space-y-5 border-white/5">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-bold flex items-center gap-2 text-white/60 uppercase">
                    <MessageSquare size={14} className="text-primary" />
                    Prompt do Sistema (Instruções)
                  </label>
                </div>
                <textarea
                  className="w-full h-[400px] bg-black/20 border border-white/5 rounded-xl p-6 font-mono text-[13px] leading-relaxed focus:ring-1 focus:ring-primary/20 outline-none transition-all scrollbar-hide text-white/80"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Defina as regras da sua IA aqui..."
                />

                <div className="flex items-center justify-between pt-4">
                  <button
                    onClick={savePrompt}
                    disabled={saving}
                    className="bg-primary hover:bg-blue-600 disabled:opacity-50 px-10 py-3.5 rounded-xl font-black text-xs transition-all flex items-center gap-2 shadow-xl shadow-primary/20"
                  >
                    {saving ? <RefreshCw className="animate-spin" size={16} /> : <Send size={16} />}
                    ATUALIZAR IA
                  </button>
                  <p className="text-[10px] text-white/10 font-bold uppercase tracking-tight">Sync v1.265</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Mantive o componente Brokers mas filtrado pelo user.id */}
        {activeTab === 'brokers' && (
          <div className="space-y-6 max-w-6xl mx-auto">
            <div className="flex justify-between items-center">
              <header>
                <h2 className="text-2xl font-extrabold tracking-tight">Time de Corretores</h2>
                <p className="text-white/40 text-xs">Gestão de plantão e distribuição inteligente.</p>
              </header>
              <button className="bg-primary hover:bg-blue-600 px-5 py-2.5 rounded-xl font-bold text-xs flex items-center gap-2 transition-all">
                <UserPlus size={16} />
                NOVO CORRETOR
              </button>
            </div>

            <div className="glass-card overflow-hidden border-white/5 bg-black/10">
              <table className="w-full text-left">
                <thead className="bg-white/5 text-white/30 text-[9px] uppercase tracking-widest font-black">
                  <tr>
                    <th className="p-5">Nome</th>
                    <th className="p-5">Status</th>
                    <th className="p-5">Leads Recebidos</th>
                    <th className="p-5">Fila</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {brokers.length === 0 ? (
                    <tr>
                      <td colSpan="4" className="p-10 text-center text-white/10 italic text-sm">Nenhum corretor ativo no momento.</td>
                    </tr>
                  ) : brokers.map((broker, idx) => (
                    <tr key={broker.id} className="hover:bg-white/5 transition-colors">
                      <td className="p-5">
                        <div className="flex items-center gap-3">
                          <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center font-bold text-primary text-[10px]">
                            {broker.name.charAt(0)}
                          </div>
                          <span className="font-bold text-xs">{broker.name}</span>
                        </div>
                      </td>
                      <td className="p-5">
                        <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${broker.is_active ? 'bg-success/10 text-success' : 'bg-red-500/10 text-red-400'}`}>
                          {broker.is_active ? 'ATIVO' : 'OFF'}
                        </span>
                      </td>
                      <td className="p-5">
                        <div className="flex items-center gap-2 max-w-[100px]">
                          <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-primary/40" style={{ width: `${Math.min((broker.received_leads || 0) * 10, 100)}%` }}></div>
                          </div>
                          <span className="text-[10px] font-bold opacity-30">{broker.received_leads || 0}</span>
                        </div>
                      </td>
                      <td className="p-5">
                        {idx === 0 && <span className="text-blue-400 text-[8px] font-black border border-blue-400/30 px-2 py-0.5 rounded-full">ESTA VEZ</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function NavItem({ icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-300 ${active
        ? 'bg-primary/10 text-primary border border-primary/20'
        : 'text-white/20 hover:bg-white/5 hover:text-white'
        }`}
    >
      <div className={`${active ? 'scale-110' : 'scale-100'} transition-transform duration-300`}>
        {icon}
      </div>
      <span className="font-black text-xs uppercase tracking-tight">{label}</span>
    </button>
  );
}

function StatCard({ title, value, icon }) {
  return (
    <div className="glass-card p-5 group transition-all duration-300 hover:border-primary/20 bg-black/10">
      <div className="flex justify-between items-start mb-3">
        <span className="text-white/20 text-[9px] font-black uppercase tracking-widest">{title}</span>
        <div className="bg-white/5 p-2 rounded-lg group-hover:bg-primary/10 transition-colors">{icon}</div>
      </div>
      <div className="text-2xl font-black tracking-tighter">{value}</div>
    </div>
  );
}
