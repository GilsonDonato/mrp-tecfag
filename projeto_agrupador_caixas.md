# Projeto de Engenharia: Agrupador e Colador de Caixas Automático (90°) - Formato 2x3 (6 Unidades)
Este documento apresenta o escopo técnico revisado para o desenvolvimento e a fabricação de um **Agrupador/Colador de Caixas de 90°**, projetado para integrar a saída de uma única esteira transportadora à entrada de uma seladora em L, agrupando as caixas em lotes de **6 unidades (2 fileiras de 3 unidades)**.

---

## 1. Visão Geral do Sistema (Layout e Fluxo)

O equipamento é composto por um chassi estrutural em perfis de alumínio ou aço carbono pintado, abrigando uma esteira de entrada de fluxo contínuo, uma mesa de acumulação de baixo atrito, guias ajustáveis e dois atuadores pneumáticos principais (empurradores).

### Diagrama de Fluxo e Layout Físico (Mermaid)

```mermaid
flowchart TD
    %% Equipamentos
    subgraph Linha de Produção
        EST_IN[1. Esteira de Entrada Única] -->|Fluxo de caixas individuais| ACUM[2. Área de Acumulação Lateral]
        
        %% Mecânica do Agrupador
        subgraph Agrupador de Caixas 90°
            PIS_A[Pistão A - Empurrador Lateral] -.->|Empurra fileiras de 3 caixas| ACUM
            ACUM -->|Lote de 6 caixas formado: 2x3| PIS_B[Pistão B - Empurrador Frontal]
        end
        
        PIS_B -.->|Empurra bloco de 6 caixas| EST_SEL[3. Esteira de Entrada da Seladora L]
        EST_SEL -->|Detecção e Embalagem| SEL[4. Selagem L e Túnel Shrink]
    end
```

---

## 2. Arquitetura Mecânica e Dimensional (Ajustada para 2x3)

### Componentes Principais:
1. **Esteira de Entrada:**
   * **Tipo:** Esteira de correia plana de PVC de alto atrito ou modular plástica (Acetal). Recebe as caixas em fila indiana.
   * **Acionamento:** Motoredutor trifásico controlado por Inversor de Frequência para ajuste fino de velocidade em sincronia com a esteira alimentadora anterior.
   * **Guias Laterais:** Ajustadas especificamente para a largura da caixa individual, garantindo que elas cheguem alinhadas até a zona do Pistão A.
2. **Mesa de Acumulação Lateral:**
   * **Tipo:** Placa de aço inoxidável AISI 304 escovado com revestimento de UHMW para redução de atrito.
   * **Dimensão de Acúmulo:** Projetada para comportar exatamente a largura de **2 caixas** (duas fileiras acumuladas lateralmente) e comprimento de **3 caixas** (três caixas em fila por fileira).
3. **Pistão A - Empurrador Lateral:**
   * **Função:** Junta e empurra a fileira assim que acumula **3 caixas** em fila na esteira.
   * **Guia:** Cilindro pneumático de haste dupla guiada.
4. **Pistão B - Empurrador Frontal (Alimentador da Seladora):**
   * **Função:** Empurra a matriz final completa de **6 caixas (2x3)** para a esteira de entrada da seladora em L.
   * **Curso:** Projetado para empurrar o bloco lateralmente transpondo a transição de mesas.

---

## 3. Arquitetura Pneumática

O sistema utilizará tecnologia pneumática padrão industrial (Festo, SMC ou Micro).

### Lista de Materiais Pneumáticos (BOM):
| Item | Componente | Descrição / Função | Qtd |
| :--- | :--- | :--- | :---: |
| 01 | Cilindro Pneumático Pistão A | Cilindro de haste dupla com guias lineares, dupla ação, magnético, ø32mm, curso 150mm. | 01 |
| 02 | Cilindro Pneumático Pistão B | Cilindro de dupla ação com guias integradas ou amortecimento ajustável, ø40mm, curso 350mm. | 01 |
| 03 | Válvulas Direcionais | Válvula 5/2 vias, duplo solenoide, acionamento por 24 VDC. | 02 |
| 04 | Unidade de Preparação (FRL) | Filtro, regulador de pressão e lubrificador de ar, rosca G 1/4". Pressão de trabalho: 6 bar. | 01 |
| 05 | Sensores Magnéticos | Sensores de proximidade tipo REED instalados nas ranhuras dos cilindros (fim e início de curso). | 04 |
| 06 | Reguladores de Fluxo | Válvulas reguladoras de fluxo unidirecional para controle de velocidade dos pistões. | 04 |

---

## 4. Arquitetura Elétrica e Automação (CLP)

Para o controle do sistema, recomenda-se um CLP de pequeno porte (ex: Siemens S7-1200, Delta DVP ou Schneider M221).

### Mapeamento de Entradas e Saídas (I/O Map)

#### Entradas Digitais (DI):
* **I0.0:** Botão Liga (Painel)
* **I0.1:** Botão Desliga (Painel)
* **I0.2:** Sensor de Segurança / Emergência (NR-12)
* **I0.3:** Sensor Fotoelétrico de Entrada (Detecção de Caixa Individual na esteira)
* **I0.4:** Sensor Magnético Pistão A - Recuado
* **I0.5:** Sensor Magnético Pistão A - Avançado
* **I0.6:** Sensor Magnético Pistão B - Recuado
* **I0.7:** Sensor Magnético Pistão B - Avançado
* **I1.0:** Sensor Fotoelétrico de Acúmulo de Entrada (Segurança para evitar entupimento)

#### Saídas Digitais (DO):
* **Q0.0:** Contatora / Comando do Motor da Esteira
* **Q0.1:** Solenoide Avanço Pistão A
* **Q0.2:** Solenoide Recuo Pistão A
* **Q0.3:** Solenoide Avanço Pistão B
* **Q0.4:** Solenoide Recuo Pistão B
* **Q0.5:** Sinalizador Visual / Torre de Luz (Operação / Falha)
* **Q0.6:** Sinal de Intertravamento (Habilita ciclo da Seladora L)

---

## 5. Lógica de Funcionamento e Programação (Ajustada para 6 Caixas - 2x3)

O CLP fará a contagem de **3 caixas** por fileira. Após empurrar **2 fileiras** (totalizando 6 caixas), o Pistão B é acionado.

```pascal
// Parâmetros e Variáveis de Controle Ajustadas
VAR
    ContadorCaixas : INT := 0;      // Conta caixas na fileira atual
    ContadorFileiras : INT := 0;    // Conta fileiras empurradas na mesa
    LimiteCaixasFileira : INT := 3; // Configuração do lote (3 caixas por fileira)
    LimiteFileiras : INT := 2;      // Configuração de fileiras (2 fileiras de 3 = 6 caixas)
    HabilitaEsteira : BOOL := TRUE;
END_VAR

// Lógica Principal de Ciclo
IF Emergência_OK AND Botão_Liga THEN
    HabilitaEsteira := TRUE;
    
    // Detecção da borda de subida da caixa na entrada
    IF BordaSubida(Sensor_Entrada_Caixa) THEN
        ContadorCaixas := ContadorCaixas + 1;
    END_IF
    
    // Se a fileira atingir o limite (Ex: 3 caixas acumuladas em fila na esteira)
    IF ContadorCaixas >= LimiteCaixasFileira THEN
        HabilitaEsteira := FALSE; // Para a esteira de entrada temporariamente
        
        // Executa empurrão lateral (Pistão A - empurra a primeira fileira de 3 caixas)
        Avança_Pistao_A := TRUE;
        WAIT_UNTIL Sensor_Pistao_A_Avancado;
        Avança_Pistao_A := FALSE;
        Recua_Pistao_A := TRUE;
        WAIT_UNTIL Sensor_Pistao_A_Recuado;
        Recua_Pistao_A := FALSE;
        
        ContadorCaixas := 0;
        ContadorFileiras := ContadorFileiras + 1;
        HabilitaEsteira := TRUE; // Libera esteira novamente
    END_IF
    
    // Se o lote completo estiver formado na mesa de acúmulo (Ex: 2 fileiras de 3 = 6 caixas)
    IF ContadorFileiras >= LimiteFileiras THEN
        HabilitaEsteira := FALSE; // Bloqueia entrada durante a transferência
        
        // Aguarda 0.3s para estabilização física das caixas
        TIMER(0.3s); 
        
        // Avança Pistão B (Transfere o lote de 6 caixas para a esteira da seladora)
        Avança_Pistao_B := TRUE;
        WAIT_UNTIL Sensor_Pistao_B_Avancado;
        Avança_Pistao_B := FALSE;
        Recua_Pistao_B := TRUE;
        WAIT_UNTIL Sensor_Pistao_B_Recuado;
        Recua_Pistao_B := FALSE;
        
        // Envia sinal para disparar a Seladora L
        Dispara_Ciclo_Seladora_L := TRUE;
        TIMER_PULSE(1.0s);
        Dispara_Ciclo_Seladora_L := FALSE;
        
        ContadorFileiras := 0;
        HabilitaEsteira := TRUE;
    END_IF
ELSE
    HabilitaEsteira := FALSE;
    ContadorCaixas := 0;
    ContadorFileiras := 0;
END_IF
```

---

## 6. Requisitos de Segurança (Adequação NR-12)

* **Enclausuramento Físico:** Portas de acesso com chaves de segurança duplo canal monitoradas por relé.
* **Purga Pneumática:** Válvula de segurança de exaustão rápida (dump valve) para despressurizar os atuadores em caso de acionamento do botão de emergência ou abertura de proteções.
