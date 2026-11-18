import admin from 'firebase-admin';
import { chromium } from 'playwright';

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

function stripAccents(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeText(s) {
  return stripAccents(s).toLowerCase();
}

function parsePrice(val) {
  if (typeof val === 'number') return val > 0 ? val : null;
  if (!val) return null;
  let str = String(val).replace(/[^\d.,]/g, '').trim();
  if (!str) return null;

  if (str.includes(',') && str.includes('.')) {
    if (str.lastIndexOf(',') > str.lastIndexOf('.')) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  } else if (str.includes(',')) {
    str = str.replace(',', '.');
  }

  const num = parseFloat(str);
  return isNaN(num) || num <= 0 ? null : num;
}

function scoreMatch(candidateText, perfumeName) {
  const cand = normalizeText(candidateText);
  const target = normalizeText(perfumeName);
  const tokens = target.split(/\s+/).filter((t) => t.length > 1);

  let score = 0;
  for (const token of tokens) {
    if (cand.includes(token)) score += 2;
  }

  // Proteção para não misturar frascos de tamanhos diferentes (ex: 50ml vs 100ml)
  const mlDesejado = target.match(/(\d+)\s*ml/);
  const mlCandidato = cand.match(/(\d+)\s*ml/);
  if (mlDesejado && mlCandidato) {
    if (mlDesejado[1] === mlCandidato[1]) score += 5;
    else score -= 8;
  }

  return score;
}

function extractBrlPriceFromText(text) {
  const regex = /(\d+\s*x\s*(?:de\s*)?)?R\$\s*([\d.]+,\d{2})/gi;
  const prices = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match[1]) continue; // Ignora preços parcelados tipo "10x de R$"
    const val = parsePrice(match[2]);
    if (val) prices.push(val);
  }

  if (prices.length === 0) return null;
  return Math.min(...prices);
}

async function findBestResultOnPage(page, perfumeName) {
  const candidates = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('a, article, li, div')];
    const results = [];

    for (const el of blocks) {
      const text = (el.innerText || '').trim();
      if (text.length < 10 || text.length > 350) continue;
      if (!/R\$\s*[\d.]+,\d{2}/i.test(text)) continue;

      const link = el.tagName === 'A' ? el.href : el.querySelector('a')?.href || null;
      results.push({ text, link });
    }
    return results;
  });

  let best = null;
  let bestScore = -999;

  for (const item of candidates) {
    const preco = extractBrlPriceFromText(item.text);
    if (!preco) continue;

    const score = scoreMatch(item.text, perfumeName);
    if (score > bestScore || (score === bestScore && best && item.text.length < best.text.length)) {
      bestScore = score;
      best = { ...item, preco };
    }
  }

  if (!best || bestScore < 2) {
    return { ok: false, motivo: 'Produto não encontrado na busca' };
  }

  const esgotado = /esgotado|indispon[ií]vel|sem estoque/i.test(best.text);
  const primeiraLinha = best.text.split('\n').map((l) => l.trim()).find(Boolean) || '';

  return {
    ok: true,
    preco: best.preco,
    emEstoque: !esgotado,
    urlEncontrada: best.link || page.url(),
    produtoEncontrado: primeiraLinha.slice(0, 80)
  };
}

async function localizarInputBusca(page) {
  const seletoresBusca = [
    'input[type="search"]',
    'input[placeholder*="pesquis" i]',
    'input[placeholder*="busc" i]',
    'input[placeholder*="procur" i]',
    'input[placeholder*="o que" i]',
    'input[name*="search" i]',
    'input[name*="busca" i]',
    'input[name="q"]',
    'input[type="text"]'
  ];

  async function acharVisivel() {
    for (const sel of seletoresBusca) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) && (await loc.isVisible().catch(() => false))) {
        return loc;
      }
    }
    return null;
  }

  let input = await acharVisivel();

  if (!input) {
    const botoesLupa = [
      'button[aria-label*="busc" i]',
      'button[aria-label*="pesquis" i]',
      'button[aria-label*="search" i]',
      '[class*="search" i] button',
      '[class*="busca" i]'
    ];
    for (const btnSel of botoesLupa) {
      const btn = page.locator(btnSel).first();
      if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(700);
        input = await acharVisivel();
        if (input) break;
      }
    }
  }

  return input;
}

async function main() {
  const [lojasSnap, produtosSnap, radarSnap] = await Promise.all([
    db.collection('lojas').limit(5).get(),
    db.collection('produtos').get(),
    db.collection('radarPrecos').get()
  ]);

  const lojas = lojasSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const radarAtual = new Map();
  radarSnap.docs.forEach((d) => radarAtual.set(d.id, d.data()));

  const produtos = produtosSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => Boolean(p.nome));

  console.log(`Lojas: ${lojas.length} | Produtos em "produtos": ${produtos.length}`);
  if (lojas.length === 0 || produtos.length === 0) return;

  const resultadosPorProduto = new Map();
  for (const p of produtos) {
    const antList = radarAtual.get(p.id)?.resultadosBusca || [];
    resultadosPorProduto.set(p.id, new Map(antList.map((r) => [r.loja.toLowerCase(), r])));
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'pt-BR',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  });

  try {
    for (const loja of lojas) {
      console.log(`\n=== Loja: ${loja.nome} ===`);
      const temPlaceholder = loja.urlBusca.includes('{q}');
      const page = await context.newPage();

      try {
        let inputBusca = null;

        if (!temPlaceholder) {
          await page.goto(loja.urlBusca, { waitUntil: 'domcontentloaded', timeout: 25000 });
          await page.waitForTimeout(3000);
          inputBusca = await localizarInputBusca(page);
          if (!inputBusca) {
            console.log(`  ✖ Campo de busca não encontrado em ${loja.nome}`);
          }
        }

        for (const p of produtos) {
          const radarDoc = radarAtual.get(p.id);
          const termoLimpo = stripAccents(radarDoc?.termoBusca || p.nome).trim();
          const anterior = resultadosPorProduto.get(p.id).get(loja.nome.toLowerCase());

          let res;
          try {
            if (temPlaceholder) {
              const url = loja.urlBusca.replaceAll('{q}', encodeURIComponent(termoLimpo));
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
              await page.waitForTimeout(2500);
              res = await findBestResultOnPage(page, termoLimpo);
              res.url = res.urlEncontrada || url;
            } else {
              // Se o campo sumiu por algum motivo, recarrega a página inicial da loja
              if (!inputBusca || !(await inputBusca.isVisible().catch(() => false))) {
                await page.goto(loja.urlBusca, { waitUntil: 'domcontentloaded', timeout: 25000 });
                await page.waitForTimeout(2500);
                inputBusca = await localizarInputBusca(page);
              }

              if (!inputBusca) {
                res = { ok: false, url: loja.urlBusca, motivo: 'Campo de busca não encontrado' };
              } else {
                await inputBusca.click();
                await inputBusca.fill('');
                await inputBusca.fill(termoLimpo);
                await inputBusca.press('Enter').catch(() => {});
                await page.waitForTimeout(2000);
                res = await findBestResultOnPage(page, termoLimpo);
                res.url = res.urlEncontrada || loja.urlBusca;
              }
            }
          } catch (err) {
            res = { ok: false, url: loja.urlBusca, motivo: err.message.slice(0, 80) };
          }

          if (res.ok) {
            const precoAnt = anterior?.ultimoPreco ?? null;
            const diferenca = precoAnt != null ? Number((res.preco - precoAnt).toFixed(2)) : 0;

            console.log(`  ✔ ${p.nome}: R$ ${res.preco} (variação: ${diferenca})`);

            if (precoAnt != null && diferenca !== 0) {
              await db.collection('variacoes').add({
                perfumeId: p.id,
                perfumeNome: p.nome,
                loja: loja.nome,
                precoAnterior: precoAnt,
                precoNovo: res.preco,
                diferenca,
                data: new Date().toISOString()
              });
            }

            resultadosPorProduto.get(p.id).set(loja.nome.toLowerCase(), {
              loja: loja.nome,
              url: res.url,
              ultimoPreco: res.preco,
              precoAnterior: precoAnt,
              diferenca,
              emEstoque: res.emEstoque,
              produtoEncontrado: res.produtoEncontrado,
              statusLeitura: 'ok',
              atualizadoEm: new Date().toISOString()
            });
          } else {
            console.log(`  ✖ ${p.nome}: ${res.motivo}`);
            resultadosPorProduto.get(p.id).set(loja.nome.toLowerCase(), {
              loja: loja.nome,
              url: res.url || loja.urlBusca,
              ultimoPreco: anterior?.ultimoPreco ?? null,
              precoAnterior: anterior?.precoAnterior ?? null,
              diferenca: 0,
              emEstoque: anterior?.emEstoque ?? true,
              produtoEncontrado: anterior?.produtoEncontrado ?? '',
              statusLeitura: res.motivo,
              atualizadoEm: new Date().toISOString()
            });
          }
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  // Salva os resultados na coleção separada "radarPrecos" (sem tocar na coleção "produtos")
  for (const p of produtos) {
    const listaFinal = Array.from(resultadosPorProduto.get(p.id).values());
    await db.collection('radarPrecos').doc(p.id).set({
      resultadosBusca: listaFinal,
      atualizadoEm: new Date().toISOString()
    }, { merge: true });
  }

  console.log('\nAtualização finalizada!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});