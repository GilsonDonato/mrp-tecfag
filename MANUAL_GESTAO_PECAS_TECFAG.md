# 📖 Manual Operacional v2.2 — Gestão de Peças Sob Encomenda & Reposição (`Tecfag MRP II`)

- **Link Direto de Acesso:** `https://tecfag-mrp.onrender.com/pecas`
- **Manual Web / Impressão:** `https://tecfag-mrp.onrender.com/manual-pecas`
- **Manual em PDF:** `https://tecfag-mrp.onrender.com/manual-pecas.pdf`

> [!IMPORTANT]
> **Regra de Ouro #1 — Fim da Espera no Cadastro ERP Antes da Venda:** Quando um cliente pede uma peça sem estoque e sem cadastro, o sistema gera na hora um **Pré-SKU provisório (`TMP-PEC-XXXX`)** para cotação imediata no Brasil ou na China. O cadastro oficial no ERP **só ocorre depois que o cliente aprova o orçamento**.

> [!WARNING]
> **Regra de Ouro #2 — Governança & Trava de Responsabilidade por Etapa:** Todos os usuários podem abrir os cards para **consultar dados, copiar SKUs/textos e enviar mensagens no Chat Interno**, mas **somente os responsáveis oficiais da etapa atual podem alterar campos ou avançar o card** (`✏️ Sua Etapa` vs `🔒 Consulta`). Administradores Master (**Gilson** e **Fernando**) possuem chave-mestra total e podem editar os responsáveis a qualquer momento no botão **`🛡️ Responsáveis por Etapa`**.

---

## 1. Matriz Oficial de Responsáveis & Equipe Autorizada (Abertura + Etapas 1 a 6)

| Atividade / Etapa | Responsável(is) Autorizado(s) p/ Edição | Demais Usuários | Ação Principal |
| :--- | :--- | :--- | :--- |
| **➕ Abertura da Solicitação** | **Guilherme Bertola** (`vendas18@tecfag.com.br`), **Raiane Aguiar** (`assistencia@tecfag.com.br`), **Maria Vitória** (`assistencia4@tecfag.com.br`), **Keicy Cardoso** (`vendas21@tecfag.com.br`) e **Matheus Henrique** (`assistencia7@tecfag.com.br`) | 🔒 Bloqueado | Cadastrar Cliente + E-mail do Cliente + Máquina(s) + Foto(s). |
| **1️⃣ Etapa 1 — Triagem Técnica** | **Jhenifer** (`jhenifer` / `adm@tecfag.com.br`) | 🔒 Somente Consulta + Chat | Revisar Cód. Antigo / Nome em Inglês, definir Brasil vs. Importação **ou isolar item já cadastrado e c/ estoque no ERP**. |
| **2️⃣ Etapa 2 — Cotação & Preço** | **Jhenifer** (`jhenifer` / `adm@tecfag.com.br`) | 🔒 Somente Consulta + Chat | Disparar e-mail corporativo c/ fotos ao fornecedor e formar preço (`FOB×Dólar×2×2`). |
| **3️⃣ Etapa 3 — Proposta & Decisão** | **Guilherme Bertola**, **Raiane Aguiar**, **Maria Vitória**, **Keicy Cardoso** e **Matheus Henrique** | 🔒 Somente Consulta + Chat | Enviar proposta oficial c/ logo Tecfag p/ e-mail do cliente e confirmar Aprovação/Declínio. |
| **4️⃣ Etapa 4 — Fila Cadastro ERP** | **Jhenifer** (`jhenifer` / `adm@tecfag.com.br`) | 🔒 Somente Consulta + Chat | Cadastrar SKU Oficial no ERP (só vendas aprovadas sob encomenda!) e confirmar De-Para. |
| **5️⃣ Etapa 5 — Compra & Trânsito** | **Jhenifer** (`jhenifer` / `adm@tecfag.com.br`) | 🔒 Somente Consulta + Chat | Registrar OC / Rastreio DHL ou incluir de carona em Container aberto no Comex. |
| **6️⃣ Etapa 6 — Doca & NF Saída** | **Jhenifer** (`jhenifer` / `adm@tecfag.com.br`) | 🔒 Somente Consulta + Chat | Dar entrada na doca, emitir Etiqueta Reservada e informar NF de Saída. |
| **👑 Chave-Mestra Admin** | **Gilson Donato** (`gilson` / `admin`) e **Fernando** (`fernando`) | Acesso Total Irrestrito | Editar/destravar qualquer etapa, excluir cards e gerenciar `🛡️ Responsáveis por Etapa`. |

---

## 2. Passo a Passo Operacional Completo

### Passo 1 — Abertura da Solicitação, Alerta Anti-Duplicidade & Multi-Máquinas (`Guilherme, Raiane, Maria Vitória, Keicy e Matheus`)
1. No MRP Tecfag, acesse **⚙️ Peças & Reposição ↗** (`/pecas`) e clique em **➕ Nova Solicitação de Peça**.
2. **Cliente & E-mail:** Busque o cliente pelo nome ou CNPJ — o sistema puxa automaticamente telefone e **📧 E-mail do Cliente** da base do ERP. Em emergências, marque **🔥 MÁQUINA PARADA NO CLIENTE!**.
3. **Máquina Principal:** Pesquise pelo código ou modelo (ex.: `ARLM-160B` ou `PAMQIPMN084`). O sistema preenche sozinho o **🏷️ Cód. Antigo (Código Original no Fornecedor)** e o **🏭 Nome do Fabricante**.
4. **Dica Automática de Peças Existentes ("Vacina contra Pesquisa Errada"):** Ao digitar 3 ou mais letras no nome da peça, o sistema busca automaticamente na **Árvore de Peças da Máquina** e na base do ERP (`PAPC...`), exibindo um alerta amarelo caso já exista item similar cadastrado — permitindo conferir o saldo físico no ERP antes de abrir card sem necessidade!
5. **Mais de uma peça (Mesma Máquina ou OUTRAS Máquinas):**
   - Clique em **➕ Adicionar Outra Peça** quantas vezes precisar.
   - Se o cliente pedir no mesmo chamado peças de **outra máquina diferente**, clique em **🔄 Peça de OUTRA Máquina? Clique aqui** na linha daquela peça e selecione o segundo equipamento!
6. Anexe a **📷 Foto da Peça** em cada item e deixe o SKU ERP vazio quando for peça nova.

### Passo 2 — Triagem Técnica: Brasil vs. Importação vs. Peça Já em Estoque no ERP (`Jhenifer` — Etapa 1)
1. Abra o card na Aba **1️⃣ Escopo, Máquina & Triagem**, revise a máquina/Cód. Antigo de cada peça e o **Nome em Inglês**.
2. **Defina a Decisão Técnica individual de cada peça:**
   - **🇧🇷 Compra Interna no Brasil**, **🌎 Cotar Ambos** ou **🇨🇳 Importação Obrigatória** para as peças que realmente serão compradas/cotadas.
   - **📦 Já Cadastrado & C/ Estoque (Atender pelo ERP):** Use quando o vendedor incluiu no card uma peça que a Tecfag **já possui cadastrada e com estoque no ERP** (ex.: card com *Motor + Mola*, onde a *Mola* já tem estoque):
     1. Pesquise e selecione o **🔎 SKU Oficial Existente no ERP** no campo verde que se abre na hora e preencha o **💬 Aviso p/ o Vendedor** (ex.: *"Temos 10 un na prateleira — pode faturar direto por este SKU"*).
     2. **Isolamento Automático:** O sistema grava o aviso no Histórico, exibe no topo do card um **Banner Verde com botão `📋 Copiar SKU`** para o vendedor faturar imediatamente pelo ERP, vincula esse SKU na Árvore da Máquina para evitar futuras buscas erradas, e **segue o card nas etapas seguintes apenas com as demais peças sob encomenda** (sem enviar o item em estoque para cotação no fornecedor, fila de cadastro ERP ou container!).
     3. **Card 100% em Estoque:** Se *todas* as peças do card já existirem em estoque no ERP, clique direto no botão verde **✅ Concluir Card — 100% Atendido pelo Estoque Atual** para encerrar o chamado na hora!
   - **🚫 Item Cancelado / Desconsiderado:** Remove apenas aquele item específico do cálculo e das cotações, mantendo o registro de auditoria.
3. Havendo peças pendentes de cotação externa, clique em **➡️ Concluir Triagem & Liberar p/ Cotação (Etapa 2)**.

### Passo 3 — E-mail Corporativo ao Fornecedor & Preço (`Jhenifer` — Etapa 2)
1. Na Aba **2️⃣ Cotação Fornecedor**, apenas as peças ativas sob encomenda aparecem para cotação. Clique em **📧 Enviar E-mail c/ Fotos ao Fornecedor**:
   - **Layout Corporativo Compatível com Outlook / Foxmail / Webmail:** E-mail estruturado em tabelas limpas com o **Logo Oficial Grupo Tecfag** no cabeçalho escuro e quadros individuais de fotos na proporção real.
   - **Revisão Rápida em Inglês + Proteção de SKU Interno:** No próprio modal de envio você pode editar/traduzir a descrição em Inglês de cada item; o sistema **remove automaticamente códigos internos Tecfag (`PAPC...` / `TMP-PEC-...`)**, converte unidades (`UN ➔ PCS`) e exibe apenas o **🏷️ Cód. Antigo** original do fabricante (ex.: `ARLM-160B`, `FRB-770`).
   - **Agrupamento Multi-Máquinas & Filtro por Fábrica:** Organiza descrições e fotos por máquina (`MACHINE 1`, `MACHINE 2`) e permite filtrar por fabricante (`🏭 Só Fornecedor A` / `🏭 Só Fornecedor B`).
2. Digite o **Preço FOB Unit. (US\$)** (ou custo nacional em `R\$`). O sistema aplica automaticamente:
   $$\text{Preço de Venda (R\$)} = \text{Preço FOB (US\$)} \times \text{Dólar} \times 2 \times 2$$
3. Clique em **📤 Concluir & Liberar p/ Solicitante** (ou **⚡ Concluir & Já Enviar E-mail p/ Cliente**, que já envia com cópia e resposta para quem abriu a solicitação!).

### Passo 4 — Envio Direto da Proposta Oficial c/ Logo Tecfag & Decisão (`Guilherme, Raiane, Maria Vitória, Keicy e Matheus` — Etapa 3)
1. Na Aba **3️⃣ Orçamento p/ Cliente & Decisão**, se o card possuir alguma peça marcada como **Já em Estoque ERP**, o banner verde no topo mostra o SKU oficial com o botão **📋 Copiar SKU** para faturamento imediato no ERP.
2. Clique em **📧 Enviar Proposta Oficial p/ E-mail do Cliente Agora** (sem copiar e colar!):
   - Por padrão, envia o orçamento das peças sob encomenda cotadas (com opção de marcar **`📦 Incluir também peça(s) de Estoque ("Pronta Entrega") neste mesmo e-mail`** caso queira mandar tudo junto ao cliente).
   - O cliente recebe a proposta com o **Logo Oficial Grupo Tecfag no cabeçalho**, tabela comercial, fotos e assinatura, levando **Cópia (`CC`)** e **Resposta Direta (`Reply-To`) para o e-mail corporativo de quem solicitou/enviou**! (Opcional: conecte sua conta em **🔑 Meu E-mail** ou use **📋 Copiar p/ WhatsApp**).
3. **Decisão do Cliente:** Se aprovar, clique em **✅ Confirmar Venda Aprovada!** (envia para a Fila ERP da Jhenifer *apenas* as peças sob encomenda que ainda não têm SKU oficial, ou avança direto para Compra). Se declinar, encerre sem gastar tempo no ERP!

### Passo 5 — Fila Expressa de Cadastro ERP (`Jhenifer` — Etapa 4)
1. Acesse a aba superior **📋 Fila Expressa Cadastro ERP (Jhenifer)**, clique em **📋 Copiar Ficha Completa p/ ERP**, crie o item no ERP, digite o **SKU Oficial ERP** e clique em **✅ Confirmar SKU & Liberar Compra** (grava na Árvore da Máquina definitivamente).

### Passo 6 — Compra, Carona Comex, Doca Carimbada & Entrega (`Jhenifer` — Etapas 5 e 6)
1. Na Aba **4️⃣ ERP, Compra, Carona Comex & Doca**, registre OC/Rastreio ou clique em **🚢 Incluir no Container** para embarcar apenas os itens importados aprovados de carona no módulo *Importações & Estoque*.
2. Na chegada física, clique em **📦 Chegou na Doca!**, imprima a **🏷️ Etiqueta de Reserva do Cliente** e, após faturar, informe a **NF de Saída** e clique em **✅ Marcar Faturado & Entregue**.
