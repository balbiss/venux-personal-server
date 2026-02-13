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
  Search
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

  useEffect(() => {
    fetchInitialData();
  }, []);

  const fetchInitialData = async () => {
    setLoading(true);
    try {
      // 1. Buscar Leads para Stats e Gráficos
      const { data: leads, error: leadsErr } = await supabase
        .from('ai_leads_tracking')
        .select('*');

      if (leads) {
        const qualified = leads.filter(l => l.status === 'TRANSFERRED').length;
        const total = leads.length;
        setStats(prev => ({
          ...prev,
          total,
          qualified,
          conversion: total > 0 ? ((qualified / total) * 100).toFixed(1) : 0
        }));

        // Dados para o gráfico de pizza
        const statusCounts = leads.reduce((acc, lead) => {
          acc[lead.status] = (acc[lead.status] || 0) + 1;
          return acc;
        }, {});

        setPieData([
          { name: 'Qualificados', value: statusCounts['TRANSFERRED'] || 0, color: '#3b82f6' },
          { name: 'Em Atendimento', value: statusCounts['AI_SENT'] || 0, color: '#10b981' },
          { name: 'Aguardando', value: statusCounts['RESPONDED'] || 0, color: '#f59e0b' },
        ]);

        // Agrupar por dia (últimos 7 dias)
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

      // 2. Buscar Corretores
      const { data: brokersList } = await supabase.from('real_estate_brokers').select('*');
      setBrokers(brokersList || []);
      setStats(prev => ({ ...prev, activeBrokers: brokersList?.length || 0 }));

      // 3. Buscar Instâncias e Prompt (da tabela bot_sessions)
      const { data: sessions } = await supabase.from('bot_sessions').select('*');
      if (sessions) {
        const allInsts = [];
        sessions.forEach(s => {
          const insts = s.data?.whatsapp?.instances || [];
          insts.forEach(i => allInsts.push({ ...i, owner_chat_id: s.chat_id }));
        });
        setInstances(allInsts);
        if (allInsts.length > 0) {
          setSelectedInstId(allInsts[0].id);
          setPrompt(allInsts[0].ai_prompt || '');
        }
      }

    } catch (e) {
      console.error("Erro ao carregar dados:", e);
    } finally {
      setLoading(false);
    }
  };

  const savePrompt = async () => {
    if (!selectedInstId) return;
    setSaving(true);
    try {
      const inst = instances.find(i => i.id === selectedInstId);
      if (!inst) return;

      const { data: sessionData } = await supabase
        .from('bot_sessions')
        .select('data')
        .eq('chat_id', inst.owner_chat_id)
        .single();

      if (sessionData) {
        const updatedData = { ...sessionData.data };
        const instIndex = updatedData.whatsapp.instances.findIndex(i => i.id === selectedInstId);
        if (instIndex !== -1) {
          updatedData.whatsapp.instances[instIndex].ai_prompt = prompt;
          await supabase
            .from('bot_sessions')
            .update({ data: updatedData })
            .eq('chat_id', inst.owner_chat_id);

          alert("✅ Prompt atualizado com sucesso!");
        }
      }
    } catch (e) {
      alert("❌ Erro ao salvar prompt.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-background">
        <RefreshCw className="animate-spin text-primary" size={48} />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-white/5 bg-black/40 flex flex-col">
        <div className="p-6">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-accent bg-clip-text text-transparent italic">
            VENUX AI
          </h1>
          <p className="text-[10px] text-white/30 uppercase tracking-[2px] mt-1">SDR SaaS Platform</p>
        </div>

        <nav className="flex-1 px-4 space-y-2 py-4">
          <NavItem
            icon={<LayoutDashboard size={20} />}
            label="Dashboard"
            active={activeTab === 'dashboard'}
            onClick={() => setActiveTab('dashboard')}
          />
          <NavItem
            icon={<Settings size={20} />}
            label="IA SDR"
            active={activeTab === 'ia'}
            onClick={() => setActiveTab('ia')}
          />
          <NavItem
            icon={<Users size={20} />}
            label="Corretores"
            active={activeTab === 'brokers'}
            onClick={() => setActiveTab('brokers')}
          />
        </nav>

        <div className="p-4 border-t border-white/5">
          <button className="flex items-center gap-3 text-white/50 hover:text-white transition-colors w-full p-2 rounded-lg">
            <LogOut size={18} />
            <span>Sair</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-8">
        {activeTab === 'dashboard' && (
          <div className="space-y-8 max-w-7xl mx-auto">
            <header className="flex justify-between items-end">
              <div>
                <h2 className="text-3xl font-bold">Resumo Geral</h2>
                <p className="text-white/50">Performance em tempo real da sua operação.</p>
              </div>
              <button onClick={fetchInitialData} className="p-2 hover:bg-white/5 rounded-full transition-colors">
                <RefreshCw size={20} className="text-white/30" />
              </button>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <StatCard title="Total de Leads" value={stats.total} icon={<MessageSquare className="text-blue-400" />} />
              <StatCard title="Qualificados" value={stats.qualified} icon={<CheckCircle2 className="text-success" />} />
              <StatCard title="Conversão" value={`${stats.conversion}%`} icon={<TrendingUp className="text-accent" />} />
              <StatCard title="Corretores" value={stats.activeBrokers} icon={<Users className="text-white" />} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 glass-card p-6 min-h-[400px]">
                <h3 className="text-xl font-semibold mb-6 flex items-center gap-2">
                  <BarChart3 size={20} className="text-primary" />
                  Atividade da Semana
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                    <XAxis dataKey="name" stroke="#ffffff30" fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis stroke="#ffffff30" fontSize={11} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#121212', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px', color: '#fff' }}
                    />
                    <Line type="monotone" dataKey="leads" stroke="#3b82f6" strokeWidth={3} dot={{ fill: '#3b82f6', r: 4 }} name="Total" />
                    <Line type="monotone" dataKey="qualified" stroke="#10b981" strokeWidth={3} dot={{ fill: '#10b981', r: 4 }} name="Qualificados" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="glass-card p-6 flex flex-col">
                <h3 className="text-xl font-semibold mb-6">Status da Base</h3>
                <div className="flex-1 flex items-center justify-center">
                  <ResponsiveContainer width="100%" height={250}>
                    <PieChart>
                      <Pie data={pieData} innerRadius={65} outerRadius={85} paddingAngle={8} dataKey="value">
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ backgroundColor: '#121212', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-3 mt-4">
                  {pieData.map(item => (
                    <div key={item.name} className="flex justify-between text-xs">
                      <span className="text-white/50 flex items-center gap-2 font-medium">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }}></span>
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
          <div className="space-y-8 max-w-5xl mx-auto">
            <header>
              <h2 className="text-3xl font-bold">Configuração de IA SDR</h2>
              <p className="text-white/50">Gerencie a personalidade e o conhecimento da sua IA.</p>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
              <div className="lg:col-span-1 space-y-4">
                <div className="glass-card p-4">
                  <label className="text-xs font-bold text-white/30 uppercase tracking-wider mb-2 block">Instância</label>
                  <select
                    className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-sm outline-none focus:border-primary transition-all"
                    value={selectedInstId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setSelectedInstId(id);
                      setPrompt(instances.find(i => i.id === id)?.ai_prompt || '');
                    }}
                  >
                    {instances.map(inst => (
                      <option key={inst.id} value={inst.id} className="bg-background">{inst.name}</option>
                    ))}
                  </select>
                </div>

                <div className="glass-card p-6 border-l-4 border-primary">
                  <h4 className="font-bold text-sm mb-2">Dica de Prompt</h4>
                  <p className="text-xs text-white/60 leading-relaxed">
                    Seja específico sobre o nicho. Ex: "Você é um especialista em vendas do empreendimento Vista Bella."
                  </p>
                </div>
              </div>

              <div className="lg:col-span-3 glass-card p-6 space-y-6">
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <label className="text-sm font-semibold flex items-center gap-2">
                      <MessageSquare size={16} className="text-primary" />
                      Prompt do Sistema
                    </label>
                    <span className="text-[10px] text-white/30">Markdown Suportado</span>
                  </div>
                  <textarea
                    className="w-full h-[500px] bg-black/40 border border-white/5 rounded-2xl p-6 font-mono text-sm leading-relaxed focus:ring-2 focus:ring-primary/20 outline-none transition-all scrollbar-hide"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Cole aqui as instruções da sua IA..."
                  />
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-white/5">
                  <div className="flex gap-4">
                    <button
                      onClick={savePrompt}
                      disabled={saving}
                      className="bg-primary hover:bg-blue-600 disabled:opacity-50 px-8 py-3 rounded-xl font-semibold transition-all flex items-center gap-2 shadow-lg shadow-primary/20"
                    >
                      {saving ? <RefreshCw className="animate-spin" size={18} /> : <Send size={18} />}
                      Salvar Prompt
                    </button>
                    <label className="group flex items-center gap-2 px-6 py-3 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 cursor-pointer transition-all">
                      <FileDown size={18} className="text-white/50 group-hover:text-white" />
                      <span className="text-sm font-medium">Treinar com PDF</span>
                      <input type="file" className="hidden" />
                    </label>
                  </div>
                  <p className="text-[10px] text-white/20 italic">Última atualização: Hoje às {new Date().toLocaleTimeString()}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'brokers' && (
          <div className="space-y-8 max-w-7xl mx-auto">
            <div className="flex justify-between items-center">
              <header>
                <h2 className="text-3xl font-bold">Equipe de Vendas</h2>
                <p className="text-white/50">Controle o rodízio e a performance dos seus corretores.</p>
              </header>
              <div className="flex gap-4">
                <div className="relative">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" />
                  <input className="bg-white/5 border border-white/10 rounded-xl pl-10 pr-4 py-2 text-sm outline-none focus:border-primary/50 transition-all w-64" placeholder="Buscar corretor..." />
                </div>
                <button className="bg-primary hover:bg-blue-600 px-6 py-2 rounded-xl font-semibold flex items-center gap-2 transition-all">
                  <UserPlus size={18} />
                  Adicionar
                </button>
              </div>
            </div>

            <div className="glass-card overflow-hidden border border-white/5">
              <table className="w-full text-left">
                <thead className="bg-[#1a1a1a] text-white/40 text-[10px] uppercase tracking-widest font-bold">
                  <tr>
                    <th className="p-6">Corretor</th>
                    <th className="p-6">WhatsApp</th>
                    <th className="p-6">Status</th>
                    <th className="p-6">Performance</th>
                    <th className="p-6">Fila</th>
                    <th className="p-6 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {brokers.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="p-10 text-center text-white/20 italic">Nenhum corretor cadastrado.</td>
                    </tr>
                  ) : brokers.map((broker, idx) => (
                    <tr key={broker.id} className="hover:bg-white/5 transition-colors group">
                      <td className="p-6">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-blue-500/10 flex items-center justify-center font-bold text-primary text-xs">
                            {broker.name.charAt(0)}
                          </div>
                          <span className="font-semibold">{broker.name}</span>
                        </div>
                      </td>
                      <td className="p-6 text-white/30 font-mono text-xs">{broker.phone}</td>
                      <td className="p-6">
                        <span className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase ${broker.is_active ? 'bg-success/10 text-success' : 'bg-red-500/10 text-red-500'}`}>
                          {broker.is_active ? 'Online' : 'Offline'}
                        </span>
                      </td>
                      <td className="p-6">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
                            <div className="h-full bg-primary/40" style={{ width: '45%' }}></div>
                          </div>
                          <span className="text-[10px] font-bold">{broker.received_leads || 0}</span>
                        </div>
                      </td>
                      <td className="p-6">
                        {idx === 0 && (
                          <span className="bg-blue-500/20 text-blue-400 text-[9px] font-black uppercase tracking-tighter px-2 py-1 rounded-full border border-blue-500/30">
                            Próximo
                          </span>
                        )}
                      </td>
                      <td className="p-6 text-right">
                        <button className="text-white/10 hover:text-white transition-colors text-xs font-bold">EDITAR</button>
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
      className={`w-full flex items-center gap-3 p-3 rounded-2xl transition-all duration-300 ${active
          ? 'bg-primary/10 text-primary border border-primary/20 shadow-lg shadow-primary/5'
          : 'text-white/30 hover:bg-white/5 hover:text-white'
        }`}
    >
      <div className={`${active ? 'scale-110' : 'scale-100'} transition-transform duration-300`}>
        {icon}
      </div>
      <span className="font-bold text-sm">{label}</span>
    </button>
  );
}

function StatCard({ title, value, icon }) {
  return (
    <div className="glass-card p-6 group hover:translate-y-[-4px] transition-all duration-300 hover:border-white/20">
      <div className="flex justify-between items-start mb-4">
        <span className="text-white/30 text-[10px] font-black uppercase tracking-widest">{title}</span>
        <div className="bg-white/5 p-2 rounded-xl group-hover:bg-primary/10 transition-colors">{icon}</div>
      </div>
      <div className="text-3xl font-extrabold tracking-tight">{value}</div>
    </div>
  );
}
