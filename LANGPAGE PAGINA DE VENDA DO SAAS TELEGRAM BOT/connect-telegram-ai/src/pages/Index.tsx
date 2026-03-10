import React, { useRef } from "react";
import {
  Brain,
  FileText,
  Mic,
  Send,
  Users,
  ArrowRightLeft,
  RotateCcw,
  Sparkles,
  Bot,
  Settings,
  Zap,
  Radio,
  Shield,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import Autoplay from "embla-carousel-autoplay";

/* ─── HERO ─── */
const HeroSection = () => (
  <section className="relative min-h-[40vh] md:min-h-screen flex items-center justify-center overflow-hidden">
    {/* Grid pattern */}
    <div className="absolute inset-0 grid-pattern opacity-60" />
    {/* Glow spheres */}
    <div className="glow-sphere w-[700px] h-[700px] top-[-200px] left-1/2 -translate-x-1/2" />
    <div className="glow-sphere w-[400px] h-[400px] bottom-[10%] right-[-10%]" />

    <div className="relative z-10 container mx-auto px-6 text-center max-w-5xl">
      {/* Badge */}
      <div
        className="inline-flex items-center gap-2 px-4 py-2 md:px-5 md:py-2.5 rounded-full glass mb-4 md:mb-10 opacity-0 animate-fade-up"
        style={{ animationDelay: "0.1s" }}
      >
        <Zap className="w-3.5 h-3.5 md:w-4 h-4 text-primary" />
        <span className="text-xs md:text-sm font-semibold text-primary tracking-wide">
          SaaS de Automação via Telegram
        </span>
      </div>

      {/* Headline */}
      <h1
        className="text-2xl sm:text-4xl md:text-6xl lg:text-7xl font-extrabold leading-[1.3] md:leading-[1.1] mb-4 md:mb-7 opacity-0 animate-fade-up"
        style={{ animationDelay: "0.2s" }}
      >
        <span className="text-gradient">Connect SaaS</span>
        <br />
        <span className="text-foreground/90 text-[0.95em]">
          A Central de Automação de WhatsApp que roda direto no seu{" "}
          <span className="text-gradient-blue glow-text text-[1.05em]">Telegram</span>.
        </span>
      </h1>

      {/* Subheadline */}
      <p
        className="text-sm sm:text-base md:text-lg lg:text-xl text-muted-foreground max-w-2xl mx-auto mb-6 md:mb-12 opacity-0 animate-fade-up leading-relaxed px-4 md:px-0"
        style={{ animationDelay: "0.35s" }}
      >
        Disparos, Inteligência Artificial avançada e Gestão de Equipes em um só lugar.
        Sem painéis complexos — <span className="text-foreground font-medium">tudo via bot</span>.
      </p>

      {/* CTA */}
      <div className="opacity-0 animate-fade-up px-6 md:px-0" style={{ animationDelay: "0.5s" }}>
        <a href="https://t.me/Venux_Acessor_Personal_bot" target="_blank" rel="noopener noreferrer">
          <Button
            size="lg"
            className="w-full sm:w-auto text-base md:text-lg px-8 md:px-12 py-6 md:py-7 font-bold rounded-2xl animate-pulse-glow bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-300 group"
          >
            <Sparkles className="w-5 h-5 mr-2 group-hover:rotate-12 transition-transform" />
            Quero Começar Agora
            <ChevronRight className="w-5 h-5 ml-1 group-hover:translate-x-1 transition-transform" />
          </Button>
        </a>
      </div>

      {/* Stats */}
      <div
        className="flex flex-wrap justify-center gap-6 md:gap-16 mt-6 md:mt-16 opacity-0 animate-fade-up"
        style={{ animationDelay: "0.65s" }}
      >
        {[
          { value: "10k+", label: "Mensagens/dia" },
          { value: "99.9%", label: "Uptime" },
          { value: "< 2s", label: "Resposta da IA" },
        ].map((stat, i) => (
          <div key={i} className="text-center min-w-[100px]">
            <p className="text-2xl md:text-3xl font-extrabold text-gradient-blue">{stat.value}</p>
            <p className="text-[10px] md:text-sm text-muted-foreground mt-0.5">{stat.label}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

/* ─── AI SECTION ─── */
const AISection = () => {
  const items = [
    {
      icon: FileText,
      title: "RAG & System Prompt",
      subtitle: "Memória infinita e personalidade própria",
      description:
        "Suba seus PDFs e documentos para a IA responder com base no seu conhecimento. Personalize a personalidade e o objetivo do seu agente com System Prompt.",
    },
    {
      icon: Mic,
      title: "Ouvido Digital",
      subtitle: "Processamento em tempo real",
      description:
        "Sua IA entende e responde mensagens de Texto e Áudio perfeitamente. Processamento inteligente em tempo real para qualquer formato.",
    },
  ];

  return (
    <section className="py-1 md:py-28 relative overflow-hidden">
      <div className="glow-sphere w-[500px] h-[500px] top-[10%] left-[-10%]" />
      <div className="absolute inset-0 grid-pattern opacity-30" />

      <div className="relative container mx-auto px-6">
        <div className="text-center mb-2 md:mb-20">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass mb-1">
            <Brain className="w-4 h-4 text-primary" />
            <span className="text-[10px] md:text-xs text-primary font-bold uppercase tracking-widest">
              O Coração do Sistema
            </span>
          </div>
          <h2 className="text-2xl md:text-4xl lg:text-5xl font-extrabold px-4 md:px-0">
            <span className="text-gradient">O Agente de IA</span>{" "}
            <span className="text-foreground/80">mais completo do mercado</span>
          </h2>
        </div>

        <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
          {items.map((item, i) => (
            <div
              key={i}
              className="group relative p-8 md:p-10 rounded-3xl glass glass-hover transition-all duration-500"
            >
              {/* Icon */}
              <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-6 group-hover:bg-primary/20 group-hover:border-primary/30 transition-all duration-300">
                <item.icon className="w-8 h-8 text-primary" />
              </div>
              <p className="text-xs font-bold uppercase tracking-widest text-primary mb-2">
                {item.subtitle}
              </p>
              <h3 className="text-2xl font-bold mb-4 text-gradient">{item.title}</h3>
              <p className="text-muted-foreground leading-relaxed text-[15px]">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

/* ─── DEMO CAROUSEL ─── */
const DemoCarousel = () => (
  <section className="py-0 relative overflow-hidden bg-white/[0.01]">
    <div className="container mx-auto px-6">
      <div className="text-center mb-0">
        <h2 className="text-2xl md:text-4xl font-extrabold px-4 md:px-0">
          <span className="text-gradient">O Bot</span>{" "}
          <span className="text-foreground/80">em detalhes</span>
        </h2>
      </div>

      <Carousel
        opts={{
          align: "center",
          loop: true,
        }}
        className="w-full max-w-5xl mx-auto"
      >
        <CarouselContent className="-ml-2 md:-ml-4">
          {[
            "https://i.postimg.cc/KcsY91hw/Whats-App-Image-2026-02-14-at-13-57-10-(1).jpg",
            "https://i.postimg.cc/rpcydW5y/Whats-App-Image-2026-02-14-at-13-57-10.jpg",
          ].map((src, index) => (
            <CarouselItem key={index} className="pl-2 md:pl-4 basis-[85%] sm:basis-1/2 md:basis-1/3">
              <div className="p-1">
                <div className="relative aspect-[9/16] rounded-[2rem] overflow-hidden border border-white/10 shadow-2xl glass group transition-all duration-300 hover:border-primary/40">
                  <img
                    src={src}
                    alt={`Demonstração ${index + 1}`}
                    className="absolute inset-0 w-full h-[125%] object-cover object-top -top-[15%] transition-transform duration-500 group-hover:scale-110"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/20 to-transparent pointer-events-none" />
                </div>
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
        <div className="hidden md:flex justify-center gap-2 mt-4">
          <CarouselPrevious className="static translate-y-0" />
          <CarouselNext className="static translate-y-0" />
        </div>
      </Carousel>
    </div>
  </section>
);

/* ─── LOGISTICS / SALES SECTION ─── */
const SalesSection = () => {
  const cards = [
    {
      icon: Send,
      title: "Disparo em Massa Elite",
      description:
        "Envios para indivíduos ou grupos com agendamento inteligente. Envie na hora ou programe para o momento perfeito.",
    },
    {
      icon: Users,
      title: "Rodízio de Leads",
      description:
        "Distribuição automática de leads entre seus corretores, vendedores ou atendentes. Zero trabalho manual.",
    },
    {
      icon: RotateCcw,
      title: "Follow-up de Abandono",
      description:
        "O sistema identifica quando um cliente parou de responder e faz o follow-up automático para você.",
    },
    {
      icon: ArrowRightLeft,
      title: "Transbordo Humano",
      description:
        "A IA qualifica e, quando necessário, sabe a hora exata de chamar sua equipe para assumir o chat.",
    },
  ];

  return (
    <section className="py-1 md:py-28 relative overflow-hidden">
      <div className="glow-sphere w-[600px] h-[600px] bottom-[-15%] right-[-15%]" />
      <div className="absolute inset-0 grid-pattern opacity-20" />

      <div className="relative container mx-auto px-6">
        <div className="text-center mb-2 md:mb-20">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass mb-1">
            <Radio className="w-4 h-4 text-primary" />
            <span className="text-[10px] md:text-xs text-primary font-bold uppercase tracking-widest">
              Logística & Vendas
            </span>
          </div>
          <h2 className="text-2xl md:text-4xl lg:text-5xl font-extrabold px-4 md:px-0">
            <span className="text-gradient">Funções matadoras</span>{" "}
            <span className="text-foreground/80">para escalar</span>
          </h2>
        </div>

        <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
          {cards.map((card, i) => (
            <div
              key={i}
              className="group relative p-6 md:p-8 rounded-3xl glass glass-hover transition-all duration-500"
            >
              <div className="flex items-start gap-5">
                <div className="w-14 h-14 shrink-0 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center group-hover:bg-primary/20 group-hover:border-primary/30 transition-all duration-300">
                  <card.icon className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="text-xl font-bold mb-2">{card.title}</h3>
                  <p className="text-muted-foreground leading-relaxed text-[15px]">
                    {card.description}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

/* ─── IPHONE MOCKUP ─── */
const MockupSection = () => (
  <section className="py-1 md:py-28 relative overflow-hidden">
    <div className="glow-sphere w-[500px] h-[500px] top-[20%] left-1/2 -translate-x-1/2" />
    <div className="absolute inset-0 grid-pattern opacity-20" />

    <div className="relative container mx-auto px-6 flex flex-col items-center">
      <div className="text-center mb-4 md:mb-16 px-6">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full glass mb-2">
          <Shield className="w-4 h-4 text-primary" />
          <span className="text-[10px] md:text-xs text-primary font-bold uppercase tracking-widest">
            Dashboard no Telegram
          </span>
        </div>
        <h2 className="text-2xl md:text-4xl lg:text-5xl font-extrabold mb-2">
          <span className="text-gradient">Tudo na palma da mão</span>
        </h2>
        <p className="text-sm md:text-lg max-w-xl mx-auto text-muted-foreground px-4">
          Gerencie tudo diretamente do Telegram — sem painéis, sem complicação.
        </p>
      </div>

      {/* iPhone frame */}
      <div className="relative animate-float px-4">
        {/* Outer glow ring */}
        <div className="absolute -inset-4 rounded-[3.5rem] bg-gradient-to-b from-primary/20 via-primary/5 to-transparent blur-xl" />

        <div className="relative w-[280px] sm:w-[320px] md:w-[400px] rounded-[2.5rem] md:rounded-[3rem] border-2 border-white/10 bg-black shadow-2xl shadow-primary/10 overflow-hidden">
          {/* O vídeo real do bot enviado pelo usuário */}
          <video
            src="https://dcewhpeomzedhbsiqjmp.supabase.co/storage/v1/object/public/VIDEO/WhatsApp%20Video%202026-02-14%20at%2013.57.09.mp4"
            autoPlay
            loop
            muted
            playsInline
            className="w-full h-auto object-cover"
          />
        </div>

        {/* CTA abaixo do vídeo */}
        <div className="mt-8 flex justify-center">
          <a href="https://t.me/Venux_Acessor_Personal_bot" target="_blank" rel="noopener noreferrer">
            <Button
              size="lg"
              className="w-full sm:w-auto text-base md:text-lg px-8 md:px-12 py-6 md:py-7 font-bold rounded-2xl animate-pulse-glow bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-300 group"
            >
              <Sparkles className="w-5 h-5 mr-2 group-hover:rotate-12 transition-transform" />
              Quero Começar Agora
              <ChevronRight className="w-5 h-5 ml-1 group-hover:translate-x-1 transition-transform" />
            </Button>
          </a>
        </div>
      </div>
    </div>
  </section>
);

/* ─── TESTIMONIALS SECTION ─── */
const TestimonialsSection = () => {
  const plugin = useRef(
    Autoplay({ delay: 4000, stopOnInteraction: false })
  );

  const images = [
    "https://i.postimg.cc/dQn5gKWM/Chat-GPT-Image-14-de-fev-de-2026-14-38-58.png",
    "https://i.postimg.cc/7Ly1fBB0/Chat-GPT-Image-14-de-fev-de-2026-14-41-15.png",
    "https://i.postimg.cc/KzCthJg4/Chat-GPT-Image-14-de-fev-de-2026-14-43-33.png",
  ];

  return (
    <section className="py-2 md:py-8 relative overflow-hidden bg-white/[0.02]">
      <div className="container mx-auto px-6">
        <div className="text-center mb-2">
          <h2 className="text-2xl md:text-3xl font-extrabold px-4">
            <span className="text-gradient">Depoimentos</span>{" "}
            <span className="text-foreground/80">de quem escala</span>
          </h2>
        </div>

        <Carousel
          plugins={[plugin.current]}
          opts={{
            align: "center",
            loop: true,
          }}
          className="w-full max-w-4xl mx-auto"
        >
          <CarouselContent className="-ml-2 md:-ml-4">
            {images.map((src, index) => (
              <CarouselItem key={index} className="pl-2 md:pl-4 basis-[90%] sm:basis-1/2 md:basis-1/3">
                <div className="p-1">
                  <div className="relative aspect-[16/9] rounded-2xl overflow-hidden border border-white/10 shadow-xl glass bg-black/20">
                    <img
                      src={src}
                      alt={`Depoimento ${index + 1}`}
                      className="w-full h-full object-contain"
                    />
                  </div>
                </div>
              </CarouselItem>
            ))}
          </CarouselContent>
        </Carousel>
      </div>
    </section>
  );
};

/* ─── FOOTER ─── */
const Footer = () => (
  <footer className="py-10 border-t border-white/[0.06]">
    <div className="container mx-auto px-6 text-center">
      <p className="text-sm text-muted-foreground">
        <span className="text-gradient font-semibold">InoovaWeb</span>{" "}
        por{" "}
        <span className="text-gradient font-semibold">Balbis</span>
      </p>
    </div>
  </footer>
);

/* ─── PAGE ─── */
const Index = () => (
  <main className="min-h-screen bg-background text-foreground overflow-x-hidden">
    <HeroSection />
    <AISection />
    <DemoCarousel />
    <SalesSection />
    <MockupSection />
    <TestimonialsSection />
    <Footer />
  </main>
);

export default Index;
