# 📖 Manual Operacional v2.1 — Gestão de Peças Sob Encomenda & Reposição (`Tecfag MRP II`)

- **Link Direto de Acesso:** `https://tecfag-mrp.onrender.com/pecas`
- **Manual Web / Impressão:** `https://tecfag-mrp.onrender.com/manual-pecas`
- **Manual em PDF:** `https://tecfag-mrp.onrender.com/manual-pecas.pdf`

> [!IMPORTANT]
> **Regra de Ouro #1 — Fim da Espera no Cadastro ERP Antes da Venda:** Quando um cliente pede uma peça sem estoque e sem cadastro, o sistema gera na hora um **Pré-SKU provisório (`TMP-PEC-XXXX`)** para cotação imediata no Brasil ou na China. O cadastro oficial no ERP **só ocorre depois que o cliente aprova o orçamento**.

> [!WARNING]
> **Regra de Ouro #2 — Governança & Trava de Responsabilidade por Etapa:** Todos os usuários podem abrir os cards para **consultar dados, copiar textos e enviar mensagens no Chat Interno**, mas **somente os responsáveis oficiais da etapa atual podem alterar campos ou avançar o card** (`✏️ Sua Etapa` vs `🔒 Consulta`). Administradores Master (**Gilson** e **Fernando**) possuem chave-mestra total e podem editar os responsáveis a qualquer momento no botão **`🛡️ Responsáveis por Etapa`**.

---

## 1. Matriz Oficial de Responsáveis & Equipe Autorizada (Abertura + Etapas 1 a 6)

| Atividade / Etapa | Responsável(is) Autorizado(s) p/ Edição | Demais Usuários | Ação Principal |
| :--- | :--- | :--- | :--- |
| **➕ Abertura da Solicitação** | **Guilherme Bertola** (`vendas18@tecfag.com.br`), **Raiane Aguiar** (`assistencia@tecfag.com.br`), **Maria Vitória** (`assistencia4@tecfag.com.br`), **Keicy Cardoso** (`vendas21@tecfag.com.br`) e **Matheus Henrique** (`assistencia7@tecfag.com.br`) | 🔒 Bloqueado | Cadastrar Cliente + E-mail do Cliente + Máquina(s) + Foto(s). |
| **1️⃣ Etapa 1 — Triagem Técnica** | **Jhenifer** (`jhenifer` / `adm@tecfag.com.br`) | 🔒 Somente Consulta + Chat | Revisar Cód. Antigo / Nome em Inglês e definir Brasil vs. Importação. |
| **2️⃣ Etapa 2 — Cotação & Preço** | **Jhenifer** (`jhenifer` / `adm@tecfag.com.br`) | 🔒 Somente Consulta + Chat | Disparar e-mail agrupado c/ fotos ao fornecedor e formar preço (`FOB×Dólar×2×2`). |
| **3️⃣ Etapa 3 — Proposta & Decisão** | **Guilherme Bertola**, **Raiane Aguiar**, **Maria Vitória**, **Keicy Cardoso** e **Matheus Henrique** | 🔒 Somente Consulta + Chat | Enviar proposta oficial c/ logo Tecfag p/ e-mail do cliente e confirmar Aprovação/Declínio. |
| **4️⃣ Etapa 4 — Fila Cadastro ERP** | **Jhenifer** (`jhenifer` / `adm@tecfag.com.br`) | 🔒 Somente Consulta + Chat | Cadastrar SKU Oficial no ERP (só vendas aprovadas!) e confirmar De-Para. |
| **5️⃣ Etapa 5 — Compra & Trânsito** | **Jhenifer** (`jhenifer` / `adm@tecfag.com.br`) | 🔒 Somente Consulta + Chat | Registrar OC / Rastreio DHL ou incluir de carona em Container aberto no Comex. |
| **6️⃣ Etapa 6 — Doca & NF Saída** | **Jhenifer** (`jhenifer` / `adm@tecfag.com.br`) | 🔒 Somente Consulta + Chat | Dar entrada na doca, emitir Etiqueta Reservada e informar NF de Saída. |
| **👑 Chave-Mestra Admin** | **Gilson Donato** (`gilson` / `admin`) e **Fernando** (`fernando`) | Acesso Total Irrestrito | Editar/destravar qualquer etapa, excluir cards e gerenciar `🛡️ Responsáveis por Etapa`. |

---

## 2. Passo a Passo Operacional Completo

### Passo 1 — Abertura da Solicitação com E-mail do Cliente & Multi-Máquinas (`Guilherme, Raiane, Maria Vitória, Keicy e Matheus`)
1. No MRP Tecfag, acesse **⚙️ Peças & Reposição ↗** (`/pecas`) e clique em **➕ Nova Solicitação de Peça**.
2. **Cliente & E-mail:** Busque o cliente pelo nome ou CNPJ — o sistema puxa automaticamente telefone e **📧 E-mail do Cliente** da base do ERP. Em emergências, marque **🔥 MÁQUINA PARADA NO CLIENTE!**.
3. **Máquina Principal:** Pesquise pelo código ou modelo (ex.: `ARLM-160B` ou `PAMQIPMN084`). O sistema preenche sozinho o **🏷️ Cód. Antigo (Código Original no Fornecedor)** e o **🏭 Nome do Fabricante**.
4. **Mais de uma peça (Mesma Máquina ou OUTRAS Máquinas):**
   - Clique em **➕ Adicionar Outra Peça** quantas vezes precisar.
   - Se o cliente pedir no mesmo chamado peças de **outra máquina diferente**, clique em **🔄 Peça de OUTRA Máquina? Clique aqui** na linha daquela peça e selecione o segundo equipamento!
5. Anexe a **📷 Foto da Peça** em cada item e deixe o SKU ERP vazio quando for peça nova.

### Passo 2 — Triagem Técnica: Brasil vs. Importação (`Jhenifer` — Etapa 1)
1. Abra o card na Aba **1️⃣ Escopo, Máquina & Triagem**, revise a máquina/Cód. Antigo de cada peça e o **Nome em Inglês**.
2. Defina a rota: **🇧🇷 Compra Interna no Brasil** (sensores, resistências, correias, rolamentos, usinagem), **🌎 Cotar Ambos** ou **🇨🇳 Importação Obrigatória**, e clique em **➡️ Concluir Triagem & Liberar p/ Cotação**.

### Passo 3 — E-mail Agrupado por Máquina ao Fornecedor & Preço (`Jhenifer` — Etapa 2)
1. Na Aba **2️⃣ Cotação Fornecedor**, clique em **📧 Enviar E-mail c/ Fotos ao Fornecedor**:
   - **Uso estrito do Cód. Antigo:** Envia apenas o modelo original do fabricante (ex.: `ARLM-160B`, `FRB-770`), sem expor nomenclatura interna da Tecfag.
   - **Agrupamento Automático Multi-Máquinas:** Se houver peças de máquinas diferentes do mesmo fornecedor, o texto e os quadros de fotos embutidas saem organizados por máquina (`[MACHINE 1]` ➔ fotos `#1.1`, `#1.2`; `[MACHINE 2]` ➔ foto `#2.1`).
   - **Filtro por Fábrica:** Se houver peças de 2 fabricantes distintos, use os botões de filtro no topo do modal (`🏭 Só Fornecedor A` / `🏭 Só Fornecedor B`) para enviar um e-mail separado para cada fábrica.
2. Digite o **Preço FOB Unit. (US\$)** (ou custo nacional em `R\$`). O sistema aplica automaticamente:
   $$\text{Preço de Venda (R\$)} = \text{Preço FOB (US\$)} \times \text{Dólar} \times 2 \times 2$$
3. Clique em **📤 Concluir & Liberar p/ Solicitante** (ou use **⚡ Concluir & Já Enviar E-mail p/ Cliente**, que já envia com cópia e resposta para quem abriu a solicitação!).

### Passo 4 — Envio Direto da Proposta Oficial c/ Logo Tecfag & Decisão (`Guilherme, Raiane, Maria Vitória, Keicy e Matheus` — Etapa 3)
1. Na Aba **3️⃣ Orçamento p/ Cliente & Decisão**, clique em **📧 Enviar Proposta Oficial p/ E-mail do Cliente Agora** (sem copiar e colar!):
   - O cliente recebe a proposta formatada com o **Logo Oficial Grupo Tecfag embutido no cabeçalho escuro** (abre direto em Gmail, Outlook e Webmail sem bloqueio de imagem externa), tabela comercial, fotos das peças e assinatura corporativa.
   - Vai automaticamente com **Cópia (`CC`)** e **Resposta Direta (`Reply-To`) para o próprio e-mail corporativo de quem solicitou/enviou** (`vendas18@tecfag.com.br`, `assistencia@tecfag.com.br`, `assistencia4@tecfag.com.br`, `vendas21@tecfag.com.br` ou `assistencia7@tecfag.com.br`)!
   - **Caixa Própria Opcional (`🔑 Meu E-mail`):** Qualquer integrante pode clicar uma única vez em **🔑 Meu E-mail** no topo da tela e salvar a senha do webmail (criptografada) para que os envios saiam diretamente da própria conta. Abaixo segue também o botão **📋 Copiar p/ WhatsApp**.
2. **Decisão do Cliente:** Se aprovar, clique em **✅ Confirmar Venda Aprovada!** (vai para a Fila ERP da Jhenifer se faltar SKU oficial, ou direto para Compra se já tiver SKU). Se declinar, encerre sem gastar tempo no ERP!

### Passo 5 — Fila Expressa de Cadastro ERP (`Jhenifer` — Etapa 4)
1. Acesse a aba superior **📋 Fila Expressa Cadastro ERP (Jhenifer)**, clique em **📋 Copiar Ficha Completa p/ ERP**, crie o item no ERP, digite o **SKU Oficial ERP** e clique em **✅ Confirmar SKU & Liberar Compra** (grava na Árvore da Máquina definitivamente).

### Passo 6 — Compra, Carona Comex, Doca Carimbada & Entrega (`Jhenifer` — Etapas 5 e 6)
1. Na Aba **4️⃣ ERP, Compra, Carona Comex & Doca**, registre OC/Rastreio ou clique em **🚢 Incluir no Container** para embarcar de carona no módulo *Importações & Estoque*.
2. Na chegada física, clique em **📦 Chegou na Doca!**, imprima a **🏷️ Etiqueta de Reserva do Cliente** e, após faturar, informe a **NF de Saída** e clique em **✅ Marcar Faturado & Entregue**.
