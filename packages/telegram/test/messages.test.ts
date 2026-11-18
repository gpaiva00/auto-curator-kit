import { describe, expect, it } from "vitest";
import { agendaText, approvalText, finalText, helpText, outcomeText, platformName, queueText, skipNotice, statusText } from "../src/index.js";
import { draft, item, ui } from "./helpers.js";

describe("approvalText", () => {
  it("credit show, clean item, no media", () => {
    expect(approvalText(item(), ui())).toBe(
      [
        "🆕 Novo · p_ab12 · Título do post",
        "📊 Confiança 82% · 🎯 Instagram + TikTok · 🛡 Riscos: nenhum",
        "🔤 Só texto",
        "🔗 Fonte: https://example.com/post  ·  ✍️ Crédito: Reprodução Instagram @fonte",
        "",
        "─────────",
        "Corpo do texto.",
        "",
        "#um #dois",
        "",
        "Reprodução Instagram @fonte",
      ].join("\n"),
    );
  });

  it("credit hide drops credit line and credit in text", () => {
    const t = approvalText(item(), ui({ credit: "hide" }));
    expect(t).not.toContain("Crédito");
    expect(t).not.toContain("Reprodução");
    expect(t).toContain("🔗 Fonte: https://example.com/post\n");
  });

  it("needs_human with doubt, risks, first comment and third-party media", () => {
    const i = item({
      draft: draft({ verdict: "needs_human", skipReason: "Fato não confirmado", riskFlags: ["unverified", "outdated"], firstComment: "Link na bio" }),
      prepared: [
        { type: "image", localPath: "/a.png", thirdParty: true },
        { type: "image", localPath: "/b.png", thirdParty: true },
      ],
    });
    const t = approvalText(i, ui());
    expect(t.startsWith("⚠️ Revisar · p_ab12 · Título do post\n📊 Confiança 82% · 🎯 Instagram + TikTok · 🛡 Riscos: unverified, outdated\n❓ Dúvida: Fato não confirmado\n🖼 2 mídia(s) de terceiros: credite\n")).toBe(true);
    expect(t.endsWith("\n\n💬 Primeiro comentário: Link na bio")).toBe(true);
  });

  it("any risk flag triggers Revisar; notes used as doubt; unprepared media", () => {
    const i = item({ draft: draft({ riskFlags: ["x"], notes: "cuidado" }), media: [{ type: "image", url: "http://x/y.jpg" }] });
    const t = approvalText(i, ui());
    expect(t).toContain("⚠️ Revisar");
    expect(t).toContain("❓ Dúvida: cuidado");
    expect(t).toContain("🚫 Sem mídia preparada");
  });

  it("own prepared media shows no media line; headline truncated to 60", () => {
    const i = item({ prepared: [{ type: "image", localPath: "/a.png", thirdParty: false }], draft: draft({ headline: "H".repeat(100) }) });
    const t = approvalText(i, ui());
    expect(t).not.toMatch(/🖼|🔤|🚫/);
    expect(t.split("\n")[0]).toBe(`🆕 Novo · p_ab12 · ${"H".repeat(59)}…`);
  });
});

describe("other messages", () => {
  it("platformName", () => {
    expect([platformName("instagram"), platformName("linkedin"), platformName("tiktok"), platformName("x"), platformName("threads")]).toEqual(["Instagram", "LinkedIn", "TikTok", "X", "Threads"]);
  });

  it("finalText", () => {
    const t = finalText(item({ draft: draft({ firstComment: "oi" }) }), ui(), ["tiktok", "linkedin"]);
    expect(t).toContain("✍️ Postar manualmente no TikTok + LinkedIn · p_ab12 · Título do post");
    expect(t).toContain("Corpo do texto.\n\n#um #dois\n\nReprodução Instagram @fonte");
    expect(t).toContain("💬 Primeiro comentário: oi");
  });

  it("outcomeText covers buffer/manual/failed", () => {
    const t = outcomeText(
      item(),
      [
        { platform: "instagram", kind: "buffer", mode: "queue", scheduledAt: "2026-11-09T16:15:00Z", droppedMedia: 1 },
        { platform: "linkedin", kind: "buffer", mode: "draft" },
        { platform: "tiktok", kind: "manual" },
        { platform: "x", kind: "failed", error: "401" },
      ],
      "America/Sao_Paulo",
    );
    expect(t).toContain("🗓 Instagram: agendado para 09/11 às 13:15");
    expect(t).toContain("↳ 1 mídia(s) não anexada(s)");
    expect(t).toContain("📝 LinkedIn: rascunho salvo no Buffer");
    expect(t).toContain("✍️ TikTok: postagem manual");
    expect(t).toContain("⚠️ X: o Buffer falhou (401)");
  });

  it("queueText groups by status", () => {
    const t = queueText([item({ id: "a", status: "new" }), item({ id: "b", status: "pending_approval", priority: 100 }), item({ id: "c", status: "pending_approval" })]);
    expect(t).toContain("📋 Fila (3)");
    expect(t.indexOf("🆕 Novos (1)")).toBeLessThan(t.indexOf("🕓 Aguardando aprovação (2)"));
    expect(t).toContain("• ⭐ b · Título do post");
  });

  it("agenda, status, help, skip", () => {
    expect(agendaText([], "UTC")).toBe("🗓 Nada agendado no Buffer.");
    expect(agendaText([{ platform: "instagram", label: "L", scheduledAt: "2026-11-09T16:15:00Z" }], "America/Sao_Paulo")).toContain("• 09/11 às 13:15 · Instagram · L");
    const s = statusText({ profileName: "P", paused: true, counts: { new: 2 }, spendBRL: 1.5, budgetBRL: 50, presentedToday: 1, dailyApprovalCap: 8, gate: "cheia" });
    expect(s).toContain("⏸ Pipeline pausado");
    expect(s).toContain("R$ 1.50 de R$ 50.00");
    expect(s).toContain("🚦 cheia");
    expect(helpText()).toContain("/furar <id> — ");
    expect(helpText()).toContain("(/help, /start)");
    expect(skipNotice(item(), "duplicado")).toBe("⏭ Pulado · p_ab12 · Título do post\n\nMotivo: duplicado");
  });
});

describe("outcomeText: erro do publicador sem repetir \"Buffer:\"", () => {
  it("o prefixo do erro do Buffer não aparece duas vezes", () => {
    const out = outcomeText(item(), [{ platform: "threads", kind: "failed", error: "Buffer: o Threads aceita até 500 caracteres (o post tem 501)" }], "America/Sao_Paulo");
    expect(out).toContain("o Buffer falhou (o Threads aceita até 500 caracteres (o post tem 501))");
    expect(out).not.toMatch(/Buffer: o Threads/);
  });
});
