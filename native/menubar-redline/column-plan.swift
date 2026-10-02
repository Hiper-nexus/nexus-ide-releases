import CoreGraphics

// Plano de colunas do painel AMPLIADO do Redline. Puro (só números): decide
// quantas colunas e onde cortar a lista de contas para que TODAS caibam na
// tela sem rolagem — é o que permite um print único com todas as CLIs.
//
// Mora num arquivo próprio e SEM símbolos `private` de propósito: o harness de
// teste concatena todos os .swift num arquivo só, onde `private` não esconde
// nada; o build real compila arquivo a arquivo. Dependência de símbolo privado
// de outro arquivo passaria no teste e quebraria o binário.

/// Faixas contíguas de linhas, uma por coluna, na ordem original (o snapshot
/// já vem ordenado por consumo, então a leitura em colunas segue essa ordem).
struct ColumnPlan: Equatable {
    let ranges: [Range<Int>]
    /// Altura da coluna mais alta — o que a lista precisa de altura.
    let tallest: CGFloat

    var columnCount: Int { ranges.count }

    /// Meio ponto de folga: alturas de texto vêm em fração.
    func fits(in height: CGFloat) -> Bool { tallest <= height + 0.5 }
}

/// Divide `heights` em até `columns` faixas contíguas minimizando a coluna mais
/// alta (partição linear clássica, DP — são ~20 linhas e no máximo 4 colunas).
/// Em empate, as primeiras colunas ficam mais cheias: a última termina mais
/// curta, que é como um leitor espera que uma lista em colunas acabe.
func balancedColumns(heights: [CGFloat], columns requested: Int) -> ColumnPlan {
    let count = heights.count
    guard count > 0 else { return ColumnPlan(ranges: [], tallest: 0) }
    // Nunca mais colunas que linhas: coluna vazia é só um buraco no print.
    let columns = max(1, min(requested, count))

    var prefix = [CGFloat](repeating: 0, count: count + 1)
    for index in 0..<count { prefix[index + 1] = prefix[index] + heights[index] }

    // best[c][i]: menor "coluna mais alta" ao repartir as i primeiras linhas
    // em c colunas. cut[c][i]: onde começa a última dessas c colunas.
    var best = [[CGFloat]](repeating: [CGFloat](repeating: .infinity, count: count + 1),
                           count: columns + 1)
    var cut = [[Int]](repeating: [Int](repeating: 0, count: count + 1), count: columns + 1)
    best[0][0] = 0
    for column in 1...columns {
        for end in column...count {
            for start in (column - 1)..<end {
                let cost = max(best[column - 1][start], prefix[end] - prefix[start])
                if cost <= best[column][end] {
                    best[column][end] = cost
                    cut[column][end] = start
                }
            }
        }
    }

    var ranges: [Range<Int>] = []
    var end = count
    for column in stride(from: columns, through: 1, by: -1) {
        let start = cut[column][end]
        ranges.append(start..<end)
        end = start
    }
    return ColumnPlan(ranges: ranges.reversed(), tallest: best[columns][count])
}

/// Menor número de colunas em `minColumns...maxColumns` cujo plano cabe em
/// `availableHeight`. Se nem com `maxColumns` couber, devolve o plano de
/// `maxColumns` (o painel cai para a rolagem vertical, nunca corta conta).
func planColumns(heights: [CGFloat], availableHeight: CGFloat,
                 minColumns: Int, maxColumns: Int) -> ColumnPlan {
    let low = max(1, min(minColumns, max(1, heights.count)))
    let high = max(low, maxColumns)
    var plan = balancedColumns(heights: heights, columns: low)
    for count in low...high {
        plan = balancedColumns(heights: heights, columns: count)
        if plan.fits(in: availableHeight) { return plan }
    }
    return plan
}
