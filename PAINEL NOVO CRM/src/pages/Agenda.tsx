import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Calendar, UserPlus, Trash2, CheckCircle2, AlertCircle, ExternalLink, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useUserSession } from "@/hooks/useUserSession";
import { toast } from "sonner";

export default function Agenda() {
    const { tid } = useUserSession();
    const [loading, setLoading] = useState(true);
    const [clinicData, setClinicData] = useState<any>(null);
    const [profissionais, setProfissionais] = useState<any[]>([]);
    const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
    const [newProf, setNewProf] = useState({ nome: "", especialidade: "", google_calendar_id: "" });

    const fetchData = async () => {
        if (!tid) return;
        setLoading(true);
        try {
            // Busca dados da clínica/agenda google
            const { data: clinic, error: clinicErr } = await supabase
                .from("clinic_agendas")
                .select("*")
                .eq("owner_id", tid)
                .maybeSingle();

            if (clinicErr) throw clinicErr;
            setClinicData(clinic);

            // Busca profissionais
            const { data: profs, error: profsErr } = await supabase
                .from("profissionais")
                .select("*")
                .eq("owner_id", tid);

            if (profsErr) throw profsErr;
            setProfissionais(profs || []);
        } catch (err: any) {
            toast.error("Erro ao carregar dados: " + err.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, [tid]);

    const handleAddProfissional = async () => {
        if (!newProf.nome) {
            toast.error("O nome é obrigatório.");
            return;
        }

        try {
            const { error } = await supabase
                .from("profissionais")
                .insert([{
                    owner_id: tid,
                    nome: newProf.nome,
                    especialidade: newProf.especialidade,
                    google_calendar_id: newProf.google_calendar_id || "primary"
                }]);

            if (error) throw error;

            toast.success("Profissional adicionado com sucesso!");
            setIsAddDialogOpen(false);
            setNewProf({ nome: "", especialidade: "", google_calendar_id: "" });
            fetchData();
        } catch (err: any) {
            toast.error("Erro ao adicionar: " + err.message);
        }
    };

    const handleDeleteProfissional = async (id: string) => {
        if (!confirm("Tem certeza que deseja excluir este profissional?")) return;

        try {
            const { error } = await supabase
                .from("profissionais")
                .delete()
                .eq("id", id);

            if (error) throw error;
            toast.success("Profissional excluído.");
            fetchData();
        } catch (err: any) {
            toast.error("Erro ao excluir: " + err.message);
        }
    };

    const googleAuthUrl = `https://connect.inoovaweb.com.br/auth/google?owner_id=${tid}`;

    if (loading && !clinicData && profissionais.length === 0) {
        return (
            <div className="flex items-center justify-center p-20">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <h1 className="text-2xl font-display font-bold text-foreground">Agenda e Médicos</h1>
                <p className="text-muted-foreground mt-1">Gerencie a conexão com Google Calendar e seus profissionais.</p>
            </motion.div>

            <Tabs defaultValue="profissionais" className="w-full">
                <TabsList className="grid w-[400px] grid-cols-2">
                    <TabsTrigger value="profissionais">Profissionais</TabsTrigger>
                    <TabsTrigger value="configuracao">Configuração Google</TabsTrigger>
                </TabsList>

                <TabsContent value="profissionais" className="space-y-4 mt-4">
                    <div className="flex justify-between items-center">
                        <h2 className="text-lg font-semibold">Lista de Médicos/Vendedores</h2>
                        <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                            <DialogTrigger asChild>
                                <Button className="gap-2">
                                    <UserPlus className="h-4 w-4" /> Adicionar Profissional
                                </Button>
                            </DialogTrigger>
                            <DialogContent>
                                <DialogHeader>
                                    <DialogTitle>Novo Profissional</DialogTitle>
                                    <DialogDescription>
                                        Cadastre um novo médico ou vendedor para gerenciar a agenda.
                                    </DialogDescription>
                                </DialogHeader>
                                <div className="space-y-4 py-4">
                                    <div className="space-y-2">
                                        <Label htmlFor="nome">Nome Completo</Label>
                                        <Input
                                            id="nome"
                                            placeholder="Ex: Dr. João Silva"
                                            value={newProf.nome}
                                            onChange={(e) => setNewProf({ ...newProf, nome: e.target.value })}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="especialidade">Especialidade / Cargo</Label>
                                        <Input
                                            id="especialidade"
                                            placeholder="Ex: Cardiologista"
                                            value={newProf.especialidade}
                                            onChange={(e) => setNewProf({ ...newProf, especialidade: e.target.value })}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="calendar_id">ID da Agenda Google (Opcional)</Label>
                                        <Input
                                            id="calendar_id"
                                            placeholder="Identificador da agenda secundária ou 'primary'"
                                            value={newProf.google_calendar_id}
                                            onChange={(e) => setNewProf({ ...newProf, google_calendar_id: e.target.value })}
                                        />
                                        <p className="text-[10px] text-muted-foreground">Deixe em branco para usar a agenda principal da conta conectada.</p>
                                    </div>
                                </div>
                                <DialogFooter>
                                    <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>Cancelar</Button>
                                    <Button onClick={handleAddProfissional}>Salvar</Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
                    </div>

                    <Card>
                        <CardContent className="p-0">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Nome</TableHead>
                                        <TableHead>Especialidade</TableHead>
                                        <TableHead>Agenda ID</TableHead>
                                        <TableHead className="text-right">Ações</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {profissionais.length === 0 ? (
                                        <TableRow>
                                            <TableCell colSpan={4} className="text-center py-10 text-muted-foreground">
                                                Nenhum profissional cadastrado.
                                            </TableCell>
                                        </TableRow>
                                    ) : (
                                        profissionais.map((p) => (
                                            <TableRow key={p.id}>
                                                <TableCell className="font-medium">{p.nome}</TableCell>
                                                <TableCell>{p.especialidade || "-"}</TableCell>
                                                <TableCell className="text-xs font-mono">{p.google_calendar_id}</TableCell>
                                                <TableCell className="text-right">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="text-destructive"
                                                        onClick={() => handleDeleteProfissional(p.id)}
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </TableCell>
                                            </TableRow>
                                        ))
                                    )}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="configuracao" className="mt-4">
                    <Card>
                        <CardHeader>
                            <CardTitle>Conexão com Google Calendar</CardTitle>
                            <CardDescription>
                                Conecte a conta Google que gerencia as agendas da clínica.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="flex items-center gap-4 p-4 rounded-lg border bg-secondary/20">
                                {clinicData?.google_refresh_token ? (
                                    <>
                                        <div className="w-10 h-10 rounded-full bg-success/20 flex items-center justify-center">
                                            <CheckCircle2 className="h-6 w-6 text-success" />
                                        </div>
                                        <div>
                                            <p className="font-semibold text-success">Google Conectado</p>
                                            <p className="text-sm text-muted-foreground">Sua clínica já possui acesso ao Google Agenda.</p>
                                        </div>
                                    </>
                                ) : (
                                    <>
                                        <div className="w-10 h-10 rounded-full bg-warning/20 flex items-center justify-center">
                                            <AlertCircle className="h-6 w-6 text-warning" />
                                        </div>
                                        <div>
                                            <p className="font-semibold text-warning">Ação Necessária</p>
                                            <p className="text-sm text-muted-foreground">Você ainda não conectou sua conta Google.</p>
                                        </div>
                                    </>
                                )}
                            </div>

                            <div className="space-y-4">
                                <Button
                                    onClick={() => window.open(googleAuthUrl, '_blank')}
                                    variant={clinicData?.google_refresh_token ? "secondary" : "default"}
                                    className="gap-2"
                                >
                                    <Calendar className="h-4 w-4" />
                                    {clinicData?.google_refresh_token ? "Alterar Conta Google" : "Conectar Google Calendar"}
                                    <ExternalLink className="h-3 w-3" />
                                </Button>

                                <p className="text-xs text-muted-foreground">
                                    Ao conectar, o sistema terá permissão para ler e criar eventos na sua agenda para automatizar os agendamentos via IA.
                                </p>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    );
}
