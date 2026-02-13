
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
  ChevronRight,
  Menu,
  X,
  FileText,
  Upload
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
  Cell,
  Area,
  AreaChart,
  Defs,
  LinearGradient,
  Stop
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
  const [knowledgeBase, setKnowledgeBase] = useState('');
  const [saving, setSaving] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [importingPdf, setImportingPdf] = useState(false);

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
      // 1. Buscar Leads filtrados pelo owner (via instance_id que contém o chat_id)
      const { data: leads } = await supabase
        .from('ai_leads_tracking')
        .select('*')
        .ilike('instance_id', `wa_${user.id}_%`);

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

      // 2. Buscar Corretores filtrados (usando tg_chat_id conforme server.mjs)
      const { data: brokersList } = await supabase
        .from('real_estate_brokers')
        .select('*')
        .eq('tg_chat_id', user.id);
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
          setKnowledgeBase(mappedInsts[0].ai_knowledge_base || '');
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
          updatedData.whatsapp.instances[instIndex].ai_knowledge_base = knowledgeBase;

          await supabase
            .from('bot_sessions')
            .update({ data: updatedData })
            .eq('chat_id', user.id);

          alert("✅ IA Atualizada com Sucesso!");
        }
      }
    } catch (e) {
      alert("❌ Erro ao salvar.");
      console.error(e);
    } finally {
      setSaving(false);
    }
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    if (file.type === 'application/pdf') {
      try {
        setImportingPdf(true);
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument(arrayBuffer).promise;
        let fullText = '';

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map(item => item.str).join(' ');
          fullText += `\n--- Página ${i} ---\n${pageText}\n`;
        }

        setKnowledgeBase(prev => prev + (prev ? '\n\n' : '') + fullText);
        alert("✅ PDF Importado! O texto foi adicionado à Base de Conhecimento.");
      } catch (err) {
        alert("❌ Erro ao ler PDF. Verifique se o arquivo é válido.");
        console.error(err);
      } finally {
        setImportingPdf(false);
      }
    } else {
      // Tentar ler como texto (TXT, MD, CSV)
      const reader = new FileReader();
      reader.onload = (e) => {
        setKnowledgeBase(prev => prev + (prev ? '\n\n' : '') + e.target.result);
        alert("✅ Arquivo Importado!");
      };
      reader.readAsText(file);
    }
  };

  // TELA DE LOGIN
  if (!user && !loading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-[#0a0a0a] p-6">
        <div className="max-w-md w-full glass-card p-10 space-y-8 border-white/5">
          <div className="text-center space-y-2">
            <h1 className="text-5xl font-bold bg-gradient-to-r from-blue-500 via-blue-400 to-purple-500 bg-clip-text text-transparent tracking-tighter">
              VENUX AI
            </h1>
            <p className="text-white/40 text-xs uppercase tracking-[6px] font-medium">SDR Central Dashboard</p>
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
      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 w-full z-20 bg-[#0B0E14]/80 backdrop-blur-md border-b border-white/5 p-4 flex justify-between items-center">
        <h1 className="text-lg font-bold bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent tracking-tight">
          VENUX AI
        </h1>
        <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="p-2 text-white/70 hover:text-white transition-colors">
          {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>      </div>

      {/* Sidebar - Desktop & Mobile Overlay */}
      <aside className={`fixed inset-0 z-30 lg:static bg-[#0E1621] lg:bg-transparent w-full lg:w-64 border-r border-white/5 flex flex-col transition-transform duration-300 ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="p-6 hidden lg:block">
          <h1 className="text-xl font-bold bg-gradient-to-r from-cyan-400 via-blue-500 to-purple-600 bg-clip-text text-transparent tracking-tighter">
            VENUX AI
          </h1>
        </div>

        {/* Padding extra no mobile p/ não sobrepor com o X */}
        <div className="lg:hidden h-20"></div>

        <nav className="flex-1 px-4 space-y-2 py-4">
          <NavItem
            icon={<LayoutDashboard size={20} />}
            label="Dashboard"
            active={activeTab === 'dashboard'}
            onClick={() => { setActiveTab('dashboard'); setMobileMenuOpen(false); }}
          />
          <NavItem
            icon={<Settings size={20} />}
            label="IA SDR"
            active={activeTab === 'ia'}
            onClick={() => { setActiveTab('ia'); setMobileMenuOpen(false); }}
          />
          <NavItem
            icon={<Users size={20} />}
            label="Corretores"
            active={activeTab === 'brokers'}
            onClick={() => { setActiveTab('brokers'); setMobileMenuOpen(false); }}
          />
        </nav>

        <div className="p-4 border-t border-white/5">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 text-white/30 hover:text-white transition-colors w-full p-3 rounded-xl text-xs font-bold uppercase tracking-wider"
          >
            <LogOut size={18} />
            <span>Sair</span>
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-4 pt-20 lg:p-10 scrollbar-thin scrollbar-thumb-white/10">
        {activeTab === 'dashboard' && (
          <div className="space-y-6 lg:space-y-8 max-w-6xl mx-auto">
            <header className="flex justify-between items-end pb-2">
              <div>
                <h2 className="text-xl lg:text-2xl font-semibold tracking-tight text-white mb-0.5">Painel de Controle</h2>
                <p className="text-white/40 text-xs font-medium">Visão geral da performance em tempo real.</p>
              </div>
              <button onClick={fetchInitialData} className="p-2 hover:bg-white/5 rounded-lg transition-colors border border-transparent hover:border-white/5 active:scale-95">
                <RefreshCw size={18} className="text-white/40 group-hover:text-white/70" />
              </button>
            </header>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
              <StatCard title="Leads Totais" value={stats.total} icon={<MessageSquare size={18} />} color="blue" />
              <StatCard title="Qualificados" value={stats.qualified} icon={<CheckCircle2 size={18} />} color="green" />
              <StatCard title="Conversão" value={`${stats.conversion}%`} icon={<TrendingUp size={18} />} color="purple" />
              <StatCard title="Corretores" value={stats.activeBrokers} icon={<Users size={18} />} color="orange" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 glass-card p-4 lg:p-5">
                <h3 className="text-xs font-semibold mb-6 flex items-center gap-2 text-white/70 uppercase tracking-widest">
                  <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(6,182,212,0.8)]"></div>
                  Fluxo de Atendimento
                </h3>
                <div className="h-[240px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="colorLeads" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
                      <XAxis
                        dataKey="name"
                        stroke="rgba(255,255,255,0.2)"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        dy={10}
                      />
                      <YAxis
                        stroke="rgba(255,255,255,0.2)"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        dx={-10}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#17212B',
                          border: '1px solid rgba(255,255,255,0.05)',
                          borderRadius: '12px',
                          color: '#fff',
                          fontSize: '12px',
                          boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4)'
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="leads"
                        stroke="#22d3ee"
                        strokeWidth={3}
                        fillOpacity={1}
                        fill="url(#colorLeads)"
                        style={{ filter: 'drop-shadow(0 0 6px rgba(34, 211, 238, 0.4))' }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="glass-card p-6 flex flex-col">
                <h3 className="text-xs font-semibold mb-6 text-white/70 uppercase tracking-widest text-center">Distribuição</h3>
                <div className="flex-1 flex items-center justify-center min-h-[160px]">
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie
                        data={pieData}
                        innerRadius={60}
                        outerRadius={75}
                        paddingAngle={6}
                        dataKey="value"
                        stroke="none"
                      >
                        {pieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: '#151921',
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '8px',
                          color: '#fff',
                          fontSize: '11px'
                        }}
                        itemStyle={{ color: '#fff' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-3 mt-4">
                  {pieData.map(item => (
                    <div key={item.name} className="flex justify-between text-[11px]">
                      <span className="text-white/40 flex items-center gap-2 font-medium">
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
          <div className="space-y-6 max-w-4xl mx-auto">
            <header>
              <h2 className="text-xl lg:text-3xl font-extrabold tracking-tight">Cérebro da Operação</h2>
              <p className="text-white/40 text-[10px] lg:text-xs">Configure como a IA deve interagir com seus leads.</p>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
              <div className="lg:col-span-1 space-y-4">
                <div className="glass-card p-4 border-white/5">
                  <label className="text-[9px] font-black text-white/30 uppercase tracking-[2px] mb-2 block">Número Conectado</label>
                  <select
                    className="w-full bg-black/40 border border-white/10 rounded-xl p-3 text-xs outline-none focus:border-primary transition-all cursor-pointer"
                    value={selectedInstId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setSelectedInstId(id);
                      setPrompt(instances.find(i => i.id === id)?.ai_prompt || '');
                      setKnowledgeBase(instances.find(i => i.id === id)?.ai_knowledge_base || '');
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

              <div className="lg:col-span-3 space-y-6">
                {/* SYSTEM PROMPT CARD */}
                <div className="glass-card p-5 lg:p-6 space-y-4 border-white/5">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-bold flex items-center gap-2 text-white/60 uppercase">
                      <MessageSquare size={14} className="text-primary" />
                      Prompt do Sistema (Instruções)
                    </label>
                  </div>
                  <textarea
                    className="w-full h-[250px] lg:h-[300px] bg-black/20 border border-white/5 rounded-xl p-4 lg:p-6 font-mono text-[13px] leading-relaxed focus:ring-1 focus:ring-primary/20 outline-none transition-all scrollbar-hide text-white/80"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Defina as regras da sua IA aqui..."
                  />
                </div>

                {/* KNOWLEDGE BASE CARD */}
                <div className="glass-card p-5 lg:p-6 space-y-4 border-white/5">
                  <div className="flex justify-between items-center">
                    <label className="text-xs font-bold flex items-center gap-2 text-white/60 uppercase">
                      <FileText size={14} className="text-success" />
                      Base de Conhecimento (RAG)
                    </label>

                    <label className="cursor-pointer bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-lg text-[10px] font-bold flex items-center gap-2 transition-all border border-white/5 hover:border-white/10">
                      {importingPdf ? <RefreshCw className="animate-spin" size={12} /> : <Upload size={12} />}
                      {importingPdf ? "LENDO PDF..." : "IMPORTAR PDF/TXT"}
                      <input
                        type="file"
                        accept=".pdf,.txt,.md,.csv"
                        className="hidden"
                        onChange={handleFileUpload}
                        disabled={importingPdf}
                      />
                    </label>
                  </div>

                  <p className="text-[10px] text-white/30">
                    O conteúdo abaixo será usado pela IA como fonte de verdade para responder perguntas específicas.
                  </p>

                  <textarea
                    className="w-full h-[200px] bg-black/20 border border-white/5 rounded-xl p-4 lg:p-6 font-mono text-[13px] leading-relaxed focus:ring-1 focus:ring-success/20 outline-none transition-all scrollbar-hide text-white/80"
                    value={knowledgeBase}
                    onChange={(e) => setKnowledgeBase(e.target.value)}
                    placeholder="Cole aqui informações sobre preços, tabela de vendas, metragens, diferenciais, etc..."
                  />
                </div>

                <div className="flex flex-col lg:flex-row items-center justify-between pt-4 gap-4">
                  <button
                    onClick={savePrompt}
                    disabled={saving}
                    className="w-full lg:w-auto bg-primary hover:bg-blue-600 disabled:opacity-50 px-8 py-3.5 rounded-xl font-black text-xs transition-all flex items-center justify-center gap-2 shadow-xl shadow-primary/20"
                  >
                    {saving ? <RefreshCw className="animate-spin" size={16} /> : <Send size={16} />}
                    SALVAR TUDO
                  </button>
                  <p className="text-[10px] text-white/10 font-bold uppercase tracking-tight">Sync v1.268 (RAG Ready)</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'brokers' && (
          <div className="space-y-6 max-w-6xl mx-auto">
            <div className="flex justify-between items-center">
              <header>
                <h2 className="text-xl lg:text-3xl font-extrabold tracking-tight">Corretores</h2>
                <p className="text-white/40 text-[10px] lg:text-xs">Gestão de plantão e distribuição.</p>
              </header>
              <button className="bg-primary hover:bg-blue-600 px-4 py-2.5 rounded-xl font-bold text-[10px] lg:text-xs flex items-center gap-2 transition-all">
                <UserPlus size={16} />
                <span className="hidden lg:inline">NOVO CORRETOR</span>
                <span className="lg:hidden">NOVO</span>
              </button>
            </div>

            <div className="glass-card overflow-hidden border-white/5 bg-black/10">
              <div className="overflow-x-auto">
                <table className="w-full text-left min-w-[600px]">
                  <thead className="bg-white/5 text-white/30 text-[9px] uppercase tracking-widest font-black">
                    <tr>
                      <th className="p-4 lg:p-5">Nome</th>
                      <th className="p-4 lg:p-5">Status</th>
                      <th className="p-4 lg:p-5">Leads Recebidos</th>
                      <th className="p-4 lg:p-5">Fila</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {brokers.length === 0 ? (
                      <tr>
                        <td colSpan="4" className="p-10 text-center text-white/10 italic text-sm">Nenhum corretor ativo no momento.</td>
                      </tr>
                    ) : brokers.map((broker, idx) => (
                      <tr key={broker.id} className="hover:bg-white/5 transition-colors">
                        <td className="p-4 lg:p-5">
                          <div className="flex items-center gap-3">
                            <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center font-bold text-primary text-[10px]">
                              {broker.name.charAt(0)}
                            </div>
                            <span className="font-bold text-xs">{broker.name}</span>
                          </div>
                        </td>
                        <td className="p-4 lg:p-5">
                          <span className={`px-2 py-0.5 rounded text-[9px] font-black uppercase ${broker.is_active ? 'bg-success/10 text-success' : 'bg-red-500/10 text-red-400'}`}>
                            {broker.is_active ? 'ATIVO' : 'OFF'}
                          </span>
                        </td>
                        <td className="p-4 lg:p-5">
                          <div className="flex items-center gap-2 max-w-[100px]">
                            <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden">
                              <div className="h-full bg-primary/40" style={{ width: `${Math.min((broker.received_leads || 0) * 10, 100)}%` }}></div>
                            </div>
                            <span className="text-[10px] font-bold opacity-30">{broker.received_leads || 0}</span>
                          </div>
                        </td>
                        <td className="p-4 lg:p-5">
                          {idx === 0 && <span className="text-blue-400 text-[8px] font-black border border-blue-400/30 px-2 py-0.5 rounded-full">VEZ ATUAL</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
      className={`w-full flex items-center gap-4 p-3.5 mx-2 rounded-xl transition-all duration-300 group relative overflow-hidden ${active
        ? 'bg-white/[0.04] text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.05)]'
        : 'text-white/40 hover:bg-white/[0.02] hover:text-white'
        }`}
      style={{ width: 'calc(100% - 16px)' }}
    >
      {active && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 h-8 w-1 bg-cyan-500 rounded-r-full shadow-[0_0_12px_rgba(6,182,212,0.8)]"></div>
      )}

      <div className={`transition-all duration-300 pl-2 ${active ? 'text-cyan-400 drop-shadow-[0_0_8px_rgba(34,211,238,0.5)]' : 'group-hover:text-white'}`}>
        {icon}
      </div>
      <span className={`text-[13px] tracking-wide ${active ? 'font-semibold' : 'font-medium'}`}>{label}</span>

      {active && (
        <div className="absolute inset-0 bg-gradient-to-r from-cyan-500/10 to-transparent pointer-events-none"></div>
      )}
    </button>
  );
}

function StatCard({ title, value, icon, color = "blue" }) {
  const colors = {
    blue: "text-cyan-400 bg-cyan-400/10 group-hover:bg-cyan-400/20",
    green: "text-emerald-400 bg-emerald-400/10 group-hover:bg-emerald-400/20",
    purple: "text-violet-400 bg-violet-400/10 group-hover:bg-violet-400/20",
    orange: "text-amber-400 bg-amber-400/10 group-hover:bg-amber-400/20",
  };

  return (
    <div className="glass-card p-6 flex flex-col justify-between glass-card-hover group relative overflow-hidden h-full">
      <div className="absolute -top-10 -right-10 w-32 h-32 bg-gradient-to-br from-white/5 to-transparent rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none blur-xl"></div>

      <div className="flex justify-between items-start mb-4">
        <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 ${colors[color]} backdrop-blur-sm`}>
          {icon}
        </div>
      </div>

      <div>
        <span className="text-white/40 text-[11px] font-bold uppercase tracking-widest block mb-1">{title}</span>
        <div className="text-2xl font-bold text-white tracking-tight flex items-baseline gap-1">
          {value}
          <span className="text-[10px] font-normal text-white/20">/mês</span>
        </div>
      </div>
    </div>
  );
}
