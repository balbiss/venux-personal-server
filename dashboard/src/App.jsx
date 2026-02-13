import React, { useState } from 'react';
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
  FileDown
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

const MOCK_DATA = [
  { name: 'Seg', leads: 400, qualified: 240 },
  { name: 'Ter', leads: 300, qualified: 139 },
  { name: 'Qua', leads: 200, qualified: 980 },
  { name: 'Qui', leads: 278, qualified: 390 },
  { name: 'Sex', leads: 189, qualified: 480 },
  { name: 'Sáb', leads: 239, qualified: 380 },
  { name: 'Dom', leads: 349, qualified: 430 },
];

const PIE_DATA = [
  { name: 'Qualificados', value: 400, color: '#3b82f6' },
  { name: 'Em Aberto', value: 300, color: '#1f1f1f' },
  { name: 'Transbordado', value: 300, color: '#f59e0b' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [prompt, setPrompt] = useState('Você é um corretor imobiliário especialista...');

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-white/5 bg-black/40 flex flex-col">
        <div className="p-6">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-accent bg-clip-text text-transparent italic">
            VENUX AI
          </h1>
        </div>

        <nav className="flex-1 px-4 space-y-2 py-4">
          <NavItem
            icon={<LayoutDashboard size={20} />}
            label="Dashboard"
            active={activeTab === 'dashboard'}
            onClick={() => setActiveTab('dashboard')}
          />
          <NavItem
            icon={<BarChart3 size={20} />}
            label="Analytics"
            active={activeTab === 'analytics'}
            onClick={() => setActiveTab('analytics')}
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
            <header>
              <h2 className="text-3xl font-bold">Resumo Geral</h2>
              <p className="text-white/50">Bem-vindo ao centro de comando da Venux.</p>
            </header>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <StatCard title="Leads Hoje" value="124" icon={<MessageSquare className="text-blue-400" />} />
              <StatCard title="Qualificados" value="48" icon={<CheckCircle2 className="text-success" />} />
              <StatCard title="Conversão" value="38.7%" icon={<TrendingUp className="text-accent" />} />
              <StatCard title="Ativos" value="12" icon={<Users className="text-white" />} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 glass-card p-6 min-h-[400px]">
                <h3 className="text-xl font-semibold mb-6">Volume de Leads</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={MOCK_DATA}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                    <XAxis dataKey="name" stroke="#ffffff50" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="#ffffff50" fontSize={12} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#121212', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
                    />
                    <Line type="monotone" dataKey="qualified" stroke="#3b82f6" strokeWidth={3} dot={{ fill: '#3b82f6', r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="glass-card p-6 flex flex-col">
                <h3 className="text-xl font-semibold mb-6">Status dos Leads</h3>
                <div className="flex-1 flex items-center justify-center">
                  <ResponsiveContainer width="100%" height={250}>
                    <PieChart>
                      <Pie data={PIE_DATA} innerRadius={60} outerRadius={80} paddingAngle={8} dataKey="value">
                        {PIE_DATA.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ backgroundColor: '#121212', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="space-y-2 mt-4">
                  {PIE_DATA.map(item => (
                    <div key={item.name} className="flex justify-between text-sm">
                      <span className="text-white/50 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: item.color }}></span>
                        {item.name}
                      </span>
                      <span>{item.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'ia' && (
          <div className="space-y-8 max-w-4xl">
            <header>
              <h2 className="text-3xl font-bold">Configuração de IA SDR</h2>
              <p className="text-white/50">Ajuste o comportamento do seu assistente virtual.</p>
            </header>

            <div className="glass-card p-8 space-y-6">
              <div>
                <label className="block text-sm font-medium text-white/70 mb-2">Instruções do Sistema (System Prompt)</label>
                <textarea
                  className="w-full h-96 bg-black/40 border border-white/10 rounded-xl p-4 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              <div className="flex gap-4">
                <button className="bg-primary hover:bg-blue-600 px-6 py-2 rounded-lg font-medium transition-colors flex items-center gap-2">
                  <Send size={18} />
                  Salvar Alterações
                </button>
                <div className="relative">
                  <input type="file" className="hidden" id="pdf-upload" />
                  <label htmlFor="pdf-upload" className="bg-white/5 hover:bg-white/10 px-6 py-2 rounded-lg font-medium cursor-pointer transition-colors flex items-center gap-2 border border-white/10">
                    <FileDown size={18} />
                    Subir PDF de Treinamento
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'brokers' && (
          <div className="space-y-8 max-w-6xl">
            <div className="flex justify-between items-center">
              <header>
                <h2 className="text-3xl font-bold">Rodízio de Corretores</h2>
                <p className="text-white/50">Gerencie a distribuição de leads da sua equipe.</p>
              </header>
              <button className="bg-primary hover:bg-blue-600 px-6 py-2 rounded-lg font-medium flex items-center gap-2">
                <UserPlus size={18} />
                Adicionar Corretor
              </button>
            </div>

            <div className="glass-card overflow-hidden">
              <table className="w-full text-left">
                <thead className="bg-white/5 border-b border-white/10 text-white/50 text-sm">
                  <tr>
                    <th className="p-4 font-medium">Nome</th>
                    <th className="p-4 font-medium">WhatsApp</th>
                    <th className="p-4 font-medium">Status</th>
                    <th className="p-4 font-medium">Fila</th>
                    <th className="p-4 font-medium">Leads Hoje</th>
                    <th className="p-4 font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <BrokerRow name="Ricardo Corretor" phone="551199..." status="Ativo" isNext={true} leads={12} />
                  <BrokerRow name="Amanda Imóveis" phone="551198..." status="Ativo" isNext={false} leads={8} />
                  <BrokerRow name="Bruno Santos" phone="551197..." status="Afastado" isNext={false} leads={0} color="text-yellow-500" />
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
      className={`w-full flex items-center gap-3 p-3 rounded-xl transition-all ${active
          ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
          : 'text-white/50 hover:bg-white/5 hover:text-white'
        }`}
    >
      {icon}
      <span className="font-medium">{label}</span>
    </button>
  );
}

function StatCard({ title, value, icon }) {
  return (
    <div className="glass-card p-6">
      <div className="flex justify-between items-start mb-4">
        <span className="text-white/50 text-sm font-medium">{title}</span>
        <div className="bg-white/5 p-2 rounded-lg">{icon}</div>
      </div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function BrokerRow({ name, phone, status, isNext, leads, color = "text-success" }) {
  return (
    <tr className="hover:bg-white/5 transition-colors group">
      <td className="p-4 font-medium">{name}</td>
      <td className="p-4 text-white/50 font-mono text-xs">{phone}</td>
      <td className="p-4">
        <span className={`px-2 py-1 bg-black/40 border border-white/5 rounded-md text-xs font-medium ${color}`}>
          {status}
        </span>
      </td>
      <td className="p-4">
        {isNext ? (
          <span className="bg-blue-500/20 text-blue-400 text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded border border-blue-500/30">
            Próximo da Vez
          </span>
        ) : '-'}
      </td>
      <td className="p-4 font-semibold">{leads}</td>
      <td className="p-4">
        <button className="text-white/30 hover:text-white transition-colors">Editar</button>
      </td>
    </tr>
  );
}
