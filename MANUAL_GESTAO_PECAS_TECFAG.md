# Manual Operacional — Gestão de Peças Sob Encomenda & Reposição Tecfag (`/pecas`)

Guia oficial de operação do módulo **`⚙️ Peças & Reposição`** integrado ao **MRP II Grupo Tecfag**, criado para eliminar a espera de 8+ dias no atendimento de peças sem pronta entrega.

---

## Regra de Ouro do Processo
**Nenhuma cotação de peça para cliente fica parada esperando cadastro no ERP!**
1. Na abertura da solicitação, se a peça for nova, o sistema gera na hora um **Pré-SKU provisório (`TMP-PEC-XXXX`)**.
2. Compras cota imediatamente no fornecedor (Brasil ou China) usando o **Código Original do Fornecedor (`Cód. Antigo` do ERP)** + **Foto da Peça**.
3. O **Cadastro Oficial no ERP (Jhenifer)** só acontece **depois que o cliente aprova o orçamento** — evitando perda de tempo e evitando sujar o ERP com SKUs de orçamentos recusados.

---

## 1. Como Acessar e Quem Faz o Quê

Acesse o MRP Tecfag normalmente e clique no botão dourado **`⚙️ Peças & Reposição ↗`** (no menu lateral esquerdo ou no topo direito da tela). O login é automático (SSO).

| Setor / Papel | Usuários Principais | Responsabilidade no Fluxo |
| :--- | :--- | :--- |
| **Pós-Venda / Vendas** | Guilherme Bertola (`vendas18@tecfag.com.br` / `guilherme`) e Vendedores | Abrir solicitações, enviar proposta ao cliente e registrar aprovação ou declínio. |
| **Engenharia / Assistência** | Fernando, Heilio, Tarcísio (`engenharia`, `heilio`, `suporte2`) | Triagem técnica de peças novas: definir se compra no Brasil, importa da China ou cota ambos. |
| **Compras & Comex** | Equipe Compras / Jhenifer (`compras`, `jhenifer`) | Disparar e-mail c/ fotos ao fornecedor, lançar custos (`FOB` ou `R$`) e efetivar a compra. |
| **Cadastro ERP** | Jhenifer (`jhenifer` / `adm@tecfag.com.br`) | Cadastrar o SKU oficial no ERP **apenas das vendas aprovadas** pela Fila Expressa. |
| **Almoxarifado / Estoque** | Estoque (`estoque`) | Receber a peça na doca, imprimir a **Etiqueta Carimbada do Cliente** e liberar expedição. |

---

## 2. Passo a Passo das 6 Etapas

### Etapa 1 — Abrir Nova Solicitação *(Guilherme Bertola / Vendas / Assistência)*
1. Clique em **`➕ Nova Solicitação de Peça`** no canto superior direito.
2. **Cliente & Urgência:** Busque o cliente (puxa automático do ERP). Se o equipamento estiver parado, selecione **`🔥 MÁQUINA PARADA NO CLIENTE!`** para destaque máximo.
3. **Amarrar à Máquina do Cliente:** Digite o código ou nome da máquina (ex: `ARLM-160B` ou `PAMQIPMN084`). O sistema preenche sozinho da planilha do ERP:
   * **🏷️ Cód. Antigo ERP (Código Original no Fornecedor):** ex. `ARLM-160B`;
   * **🏭 Nome do Fabricante Original:** ex. `ZHEJIANG HAIZHOU PACKING MACHINERY CO.,LTD`;
   * **💡 Peças Já Conhecidas:** se essa máquina já teve peças cotadas antes, clique no atalho verde para incluir em 1 segundo.
4. **Peça(s) e Foto:** Preencha o nome da peça, quantidade e anexe a **`📷 Foto Peça`**. Se for peça nova sem cadastro, deixe o campo **SKU ERP** vazio (gera `TMP-PEC` automático).
5. *Dica:* Se já souber a especificação exata e rota de compra, marque **"Já sei a especificação exata — enviar direto para Compras Cotar"** para pular a Triagem.

### Etapa 2 — Triagem Técnica: Brasil vs. Importação *(Engenharia / Suporte — SLA 4h)*
1. Abra o card na coluna **`1. Triagem Técnica`** (Aba `1️⃣ Escopo, Máquina & Triagem`).
2. Preencha o **Nome em Inglês** (caso vá cotar fora) e defina a rota:
   * **`🇧🇷 Compra Interna no Brasil`:** sensores, relés, rolamentos, correias, pneumática, resistências sob medida ou usinagem local (preencha a *Especificação de Equivalente Nacional*).
   * **`🌎 Cotar Ambos (Brasil + China)`:** para comparar prazo rápido nacional vs. preço de importação.
   * **`🇨🇳 Importação Obrigatória`:** peça exclusiva do fabricante da máquina.
3. Clique em **`➡️ Concluir Triagem & Liberar p/ Compras Cotar`**.

### Etapa 3 — Cotação no Fornecedor & Formação de Preço *(Compras / Comex — SLA 24h a 48h)*
Abra o card na Aba **`2️⃣ Cotação Fornecedor (FOB × Dólar × 2 × 2)`**:
1. **Enviar E-mail com Fotos ao Fornecedor:**
   * Clique em **`📧 Enviar E-mail c/ Fotos ao Fornecedor`**.
   * O sistema usa **exclusivamente o `Cód. Antigo` do ERP** (ex: `ARLM-160B`) para o fornecedor identificar o equipamento original dele, sem expor o código comercial interno da Tecfag.
   * As fotos das peças vão **abertas visíveis dentro do corpo do e-mail e também anexadas como arquivo**! O e-mail digitado para o fornecedor fica salvo automaticamente para os próximos pedidos.
   * *Alternativa:* Use **`🇨🇳 Copiar p/ WeChat`** ou **`🇧🇷 Copiar p/ WhatsApp Brasil`** se preferir cotar por mensagem.
2. **Lançar Custos & Calcular Preço de Venda:**
   * **Importação:** Digite o **`Preço FOB Unit. (US$)`** + prazo. O sistema calcula sozinho com o Dólar Comercial do dia:
     `Preço Venda Cliente (R$) = Preço FOB ($) × Dólar × 2 × 2`
   * **Compra Nacional:** Digite o **`Custo Unit. Brasil (R$)`** + prazo (markup padrão `2x`, editável).
   * Escolha a **Fonte Escolhida p/ Proposta** e clique em **`📤 Concluir Cotação & Enviar p/ Proposta Cliente`**.

### Etapa 4 — Orçamento ao Cliente & Decisão *(Guilherme Bertola / Vendas)*
Na Aba **`3️⃣ Orçamento p/ Cliente & Decisão`**:
1. Clique em **`📋 Copiar Orçamento`** para enviar o texto comercial formatado ao cliente.
2. Quando o cliente responder:
   * **Aprovou:** clique em **`✅ Confirmar Venda Aprovada pelo Cliente!`** (vai para a Fila Expressa da Jhenifer se faltar SKU ERP, ou pula direto para Compra se já tiver SKU).
   * **Declinou:** informe o motivo e clique em **`Encerrar`** (não gera trabalho inútil no ERP, mas guarda o preço cotado na Árvore da Máquina).

### Etapa 5 — Fila Expressa de Cadastro no ERP *(Jhenifer — SLA 4h)*
Na aba superior **`📋 Fila Expressa Cadastro ERP (Jhenifer)`**:
1. Aparecem **somente peças de vendas aprovadas**.
2. Clique em **`📋 Copiar Ficha Completa p/ ERP`** (Descrição padronizada, Unidade, NCM sugerido, Origem Fiscal `0` ou `1`, Máquina Pai e Cód. Fabricante).
3. Cadastre no ERP oficial, digite o **SKU Oficial gerado** (ex: `PECAS0945`) e clique em **`✅ Confirmar SKU & Liberar Compra`**.
4. O card avança sozinho para **Compra & Trânsito** e grava o SKU na **Árvore da Máquina** para nunca mais precisar recadastrar!

### Etapa 6 — Compra, Carona em Container & Doca Carimbada *(Compras & Estoque)*
Na Aba **`4️⃣ ERP, Compra, Carona Comex & Doca`**:
1. **Compras:** informa OC/PO, Rastreio (`DHL / FedEx / Transportadora`) e ETA — ou clica em **`🚢 Incluir no Container`** para jogar a peça de carona dentro de um container aberto lá no módulo *Importações & Estoque*.
2. **Estoque (Chegada na Doca):** clica em **`📦 Chegou na Doca! (Carimbar p/ Cliente)`** e em **`🏷️ Gerar Etiqueta Reserva`** para imprimir e colar na caixa o aviso **`🔒 PEÇA RESERVADA P/ CLIENTE — PROIBIDO USO EM ESTOQUE GERAL`**.
3. **Finalização:** após faturar e expedir, preenche a **NF de Saída** e clica em **`✅ Marcar Faturado & Entregue`**.

---

## 3. Consulta Histórica & Radar de Estoque
* **🌳 Aba "Árvore de Peças por Máquina":** Histórico permanente de todas as peças, equivalentes nacionais e preços por máquina.
* **🔥 Selo "SUGERIDO ESTOQUE!":** Quando uma mesma peça atinge **3 ou mais solicitações**, o sistema alerta automaticamente para Compras incluir unidades de estoque no próximo container marítimo.
