# Procedimento Operacional Padrão (POP) e Workflow: Rastreabilidade de Máquinas e Equipamentos
**Setores Envolvidos:** Vendas, Compras/Importação, Estoque, Técnico/Engenharia, Gerência de Projetos e Financeiro.

---

## 1. Introdução e Objetivo
Este documento estabelece as diretrizes e fluxos operacionais para eliminar a perda de rastreabilidade de máquinas importadas e customizadas. O objetivo principal é garantir que **máquinas dedicadas a projetos customizados não sejam vendidas por engano** como estoque recorrente e que o estoque saiba exatamente o direcionamento (NR-12, montagem local ou instalação) de cada equipamento que entra na empresa.

---

## 2. Matriz de Responsabilidade (RACI)

A matriz abaixo define os papéis de cada setor nas etapas do processo.
* **R (Responsible):** Quem executa a tarefa.
* **A (Accountable):** Quem responde pela entrega e aprova o resultado.
* **C (Consulted):** Quem é consultado antes ou durante a execução (opinião técnica/comercial).
* **I (Informed):** Quem deve ser avisado sobre o andamento ou conclusão.

| Fase | Etapa / Processo | Vendas (VE) | Compras (CO) | Estoque (ES) | Técnico (TE) | Gerente de Projeto (GP) | Financeiro (FI) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Fase 1** | 1.1 Diagnóstico Técnico de Automação | **C** | - | - | **R** | **A** | - |
| | 1.2 Customização do Escopo Técnico | **C** | - | - | **R** | **A** | - |
| | 1.3 Escopo Aprovado | **R** | - | - | **I** | **A** | - |
| | 1.4 Engenharia de Fornecedores e Cotação | - | **R** | - | **C** | **A** | - |
| | 1.5 Contrato Assinado | **R** | - | - | **I** | **A** | **I** |
| **Fase 2** | 2.1 Pagamento da Invoice | - | **C** | - | - | **I** | **R/A** |
| | 2.2 Monitoramento da Produção Internacional | - | **R/A** | - | - | **I** | - |
| | 2.3 Logística de Origem e Embarque | - | **R/A** | **I** | - | **I** | - |
| | 2.4 Documentação (Envio FedEx) | - | **R/A** | **I** | - | **I** | - |
| **Fase 3** | 3.1 Desembaraço e Chegada | - | **R/A** | **R** | - | **I** | - |
| | 3.2 Vistoria de Entrada (Técnica) | - | - | **I** | **R/A** | **I** | - |
| | 3.3 Entrada no Estoque e Travas ERP | - | - | **R/A** | **I** | **I** | - |
| | 3.4 Etiquetagem Física (Plano Visual) | - | - | **R/A** | - | **I** | - |
| | 3.5 Direcionamento Operacional (Rotas) | - | - | **R** | **C** | **R/A** | - |
| **Fase 4** | 4.1 Logística de Saída (Faturamento/Expedição) | - | **I** | **R/A** | - | **I** | **R** |
| | 4.2 Start-up Técnico e Comissionamento | - | - | - | **R/A** | **I** | - |
| | 4.3 Teste SAT e Aceite Final ("Joinha") | **I** | - | - | **R** | **A** | **I** |

---

## 3. Workflow Detalhado (Fase por Fase)

```mermaid
flowchart TD
    %% Fase 1
    subgraph Fase 1: Engenharia de Vendas e Escopo
        A1[Diagnóstico Técnico de Automação] --> A2[Customização do Escopo]
        A2 --> A3[Escopo Aprovado]
        A3 --> A4[Busca de Fornecedores e Cotação]
        A4 --> A5[Contrato Assinado]
    end

    %% Fase 2
    subgraph Fase 2: Compras e Produção Internacional
        A5 --> B1[Pagamento da Invoice - Fin.]
        B1 --> B2[Produção no Fornecedor 40-50 dias]
        B2 --> B3[Embarque e Logística de Origem]
        B3 --> B4[Envio de Originais via FedEx]
    end

    %% Fase 3
    subgraph Fase 3: Recebimento e Estoque Ponto Crítico
        B4 --> C1[Desembaraço Aduaneiro]
        C1 --> C2[Chegada ao Estoque e Vistoria]
        C2 --> C3{Qual o Tipo da Máquina?}
        
        %% Decisão do Tipo de Máquina
        C3 -->|Projeto Customizado| C4[Status: RESERVADO ERP e Etiqueta VERMELHA]
        C3 -->|Estoque Recorrente| C5[Status: DISPONÍVEL ERP e Etiqueta VERDE]
        
        %% Fluxo Customizado (Alerta Automatizado)
        C4 --> C6[Alerta ERP Automático enviado para GP e Técnico]
        
        %% Rotas de Direcionamento
        C6 --> C7{Roteamento da Máquina}
        C7 -->|Rota A| C8[Status: AGUARDANDO NR-12 - Enviar para Parceiro]
        C7 -->|Rota B| C9[Status: AGUARDANDO AUTOMAÇÃO - Reter Peças Locais]
        C7 -->|Rota C| C10[Status: LIBERADA TÉCNICO - Enviar para Instalação]
    end

    %% Fase 4
    subgraph Fase 4: Entrega, Instalação e Aceite
        C10 --> D1[Transporte e Logística de Saída]
        C8 --> D1
        C9 --> D1
        D1 --> D2[Instalação e Start-up Técnico]
        D2 --> D3[Teste de Aceite SAT e Aceite Final 'Joinha']
    end

    style C4 fill:#ffcccc,stroke:#ff0000,stroke-width:2px
    style C5 fill:#ccffcc,stroke:#00aa00,stroke-width:2px
    style C8 fill:#fff0bb,stroke:#d4a373,stroke-width:1px
    style C9 fill:#fff0bb,stroke:#d4a373,stroke-width:1px
    style C10 fill:#cce5ff,stroke:#0066cc,stroke-width:2px
```

---

## 4. O Ponto Crítico: Controle de Estoque e Rastreabilidade (Fase 3)

### 4.1 A Regra de Ouro (Diferenciação Inviolável)
> [!IMPORTANT]
> Nenhuma máquina poderá entrar na empresa ou ser movimentada fisicamente sem possuir uma **Ordem de Venda (OV)** ou um **Código de Projeto** vinculado.
> - **Máquina de Venda Recorrente (Estoque Livre):** Segue o código padrão de SKU do fabricante.
> - **Máquina de Projeto (Customizada):** O ERP concatena automaticamente o SKU original com o sufixo do projeto (Ex: `SKU-9920-PRJ-CLIENTEX`). Esse código de projeto acompanha o equipamento desde a compra internacional até o aceite final.

---

### 4.2 Status de Estoque no ERP
Para evitar faturamentos indevidos por outros vendedores, o ERP deve bloquear automaticamente qualquer máquina que não possua o status `[DISPONÍVEL]`.

1. **`[DISPONÍVEL]`**: Máquina de estoque recorrente, liberada para venda por qualquer vendedor.
2. **`[RESERVADO: PROJETO - CLIENTE X]`**: Máquina customizada importada especificamente para um projeto. O faturamento está travado no ERP, liberado exclusivamente para a Ordem de Venda associada àquele cliente.
3. **`[BLOQUEADO: AGUARDANDO NR-12]`**: Equipamento fisicamente na empresa ou no parceiro integrador, passando por adequações de segurança. Bloqueado para qualquer movimentação comercial ou expedição.
4. **`[RETIDO: AGUARDANDO COMPONENTES]`**: Máquina aguardando chegada de peças de automação local (CLPs, sensores, cabos específicos).
5. **`[LIBERADO: TÉCNICO]`**: Máquina vistoriada, adequada e com testes funcionais realizados. Pronta para expedição.

---

### 4.3 Alertas Automatizados (Integração de Sistemas)
Assim que o leitor de código de barras do estoque realizar o *bip* de entrada física da máquina no ERP, o sistema executará as seguintes ações automáticas em background:
* **Trigger:** Entrada de item com sufixo `PRJ-XXXX` no sistema.
* **Ação 1:** O status do item é definido imediatamente como `[RESERVADO: PROJETO - CLIENTE X]`.
* **Ação 2:** Disparo de e-mail e notificação no canal corporativo (ex: Teams/Slack) para o **Gerente do Projeto** e o **Técnico Responsável**:
  > 📢 **ALERTA DE RECEBIMENTO DE PROJETO**  
  > A máquina **[Nome da Máquina]** (SKU: `SKU-9920-PRJ-CLIENTEX`) referente ao projeto **[Cliente X]** acaba de dar entrada física no estoque.  
  > *   **Técnico Alocado:** [Nome do Técnico]  
  > *   **Ação Necessária:** Realizar a Vistoria de Entrada em até 24 horas e definir a rota de direcionamento.

---

### 4.4 Roteamento Operacional (Direcionamento do Estoque)
O operador do estoque não deve decidir o destino da máquina. O direcionamento é automático de acordo com a ordem de serviço do projeto gerada pelo Gerente de Projetos:

* **Rota A (Adequação NR-12):** 
  * **Critério:** Máquina importada sem laudo brasileiro de segurança.
  * **Ação:** O estoque separa a máquina na área de expedição para envio ao parceiro homologado de NR-12. O status muda para `[BLOQUEADO: AGUARDANDO NR-12]`.
* **Rota B (Retenção para Automação Local):** 
  * **Critério:** Máquina precisa de montagem de painel local, integração de sensores adicionais ou software específico.
  * **Ação:** A máquina é levada para a Área de Engenharia Interna. O status muda para `[RETIDO: AGUARDANDO COMPONENTES]`.
* **Rota C (Liberada para Instalação):** 
  * **Critério:** Máquina pronta e testada internamente.
  * **Ação:** A máquina é direcionada para a área de expedição e logística de saída para entrega no cliente final. O status muda para `[LIBERADO: TÉCNICO]`.

---

## 5. Plano de Contingência Visual para o Estoque (Identificação Física)

Como contingência às falhas de sistema, o estoque adotará um controle visual físico obrigatório no momento do recebimento:

```
+-------------------------------------------------------------+
|                     ETIQUETA DE PROJETO                     |
|                   MÁQUINA BLOQUEADA - PROJETO               |
|                                                             |
|   PROJETO: _______________________ (CÓD. PRJ: ____________) |
|   CLIENTE: ________________________________________________ |
|   GERENTE DE PROJETO: _____________________________________ |
|   TÉCNICO RESPONSÁVEL: ____________________________________ |
|                                                             |
|   ROTA OPERACIONAL DESTINADA:                               |
|   [ ] ROTA A (NR-12)  [ ] ROTA B (INTEGRAÇÃO)  [ ] ROTA C (CAMPO) |
|                                                             |
|       ATENÇÃO: MÁQUINA INDISPONÍVEL PARA VENDA COMUM        |
+-------------------------------------------------------------+
```

### Regras das Etiquetas Físicas:
1. **Etiqueta Vermelha (Dorso Adesivo e Plastificado):** Colada obrigatoriamente em duas faces da embalagem das máquinas de **Projetos Customizados**. Possui todos os campos acima preenchidos à caneta permanente pelo estoquista no ato da abertura da caixa/vistoria.
2. **Etiqueta Verde:** Colada em máquinas de **Estoque Recorrente**. Contém apenas o SKU padrão e a frase: *"LIBERADO PARA VENDA"*.
3. **Etiqueta Amarela (Bloqueio Temporário):** Utilizada no ato do recebimento quando há divergência documental ou danos de transporte identificados, até que a engenharia libere o equipamento.

---

## 6. Pontos de Controle e Indicadores (KPIs)

Para monitorar os gargalos do processo e evitar atrasos na entrega final, serão mensurados os seguintes indicadores:

| KPI | O que mede | Fórmula de Cálculo | Meta | Responsável |
| :--- | :--- | :--- | :---: | :---: |
| **Lead Time de Produção** | Eficiência do fornecedor internacional | Data de embarque - Data de pagamento da invoice | $\le 50$ dias | Compras |
| **Tempo de Desembaraço** | Velocidade da liberação alfandegária | Data de entrada no estoque - Data de chegada ao porto | $\le 12$ dias | Compras / Despachante |
| **Lead Time NR-12** | Tempo gasto na adequação de segurança | Data de retorno da máquina - Data de envio ao parceiro | $\le 15$ dias | Gerente de Projetos |
| **Índice de Erro de Venda** | Rastreabilidade e acurácia do estoque | (Qtd. de máquinas de projeto vendidas por engano / Total de projetos) x 100 | **0%** | Gerente de Estoque / Vendas |
| **Tempo de Instalação (Start-up)** | Tempo do técnico na fábrica do cliente | Data do "Joinha" (SAT assinado) - Data de chegada ao cliente | $\le 5$ dias | Técnico / Engenharia |

---

## 7. Planos de Ação para Desvios (Tratamento de Anomalias)

* **Se uma máquina customizada for vendida por engano (faturamento gerado):**
  * O comercial deve ser imediatamente notificado pelo sistema (bloqueio do faturamento no ERP).
  * O faturamento é cancelado de imediato, e o Diretor de Operações deve aprovar manualmente a liberação caso haja extrema necessidade (ex.: substituição por outra máquina recorrente equivalente).
* **Se a máquina chegar sem documentação/FedEx atrasado:**
  * O estoque etiqueta a máquina fisicamente com a **Etiqueta Amarela (Bloqueio)** e aguarda a regularização alfandegária. A máquina não avança para as rotas A, B ou C até a liberação fiscal completa.
* **Se o cliente recusar o aceite final ("Joinha") no SAT:**
  * O técnico em campo abre um RNC (Relatório de Não Conformidade). A máquina entra em status `[RETIDO: MANUTENÇÃO EM CAMPO]`. A equipe de engenharia tem 48 horas para apresentar um plano de ação corretiva ao cliente.
