/**
 * Agent action: evaluate a chess position (FEN) with Stockfish. Returns the engine evaluation
 * and best continuation. Calls the chess coaching REST facade via ChessCoachClient.
 */
public with sharing class ChessCoachAnalyzePosition {

    public class Request {
        @InvocableVariable(
            label='FEN'
            description='Current position in Forsyth-Edwards Notation'
            required=true
        )
        public String fen;
    }

    public class Result {
        @InvocableVariable(label='Evaluation' description='Human-readable evaluation, White perspective')
        public String evaluation;
        @InvocableVariable(label='Best Move' description='Engine best move in SAN')
        public String bestMove;
        @InvocableVariable(label='Principal Variation' description='Best line the engine sees')
        public String principalVariation;
    }

    @InvocableMethod(
        label='Analyze Chess Position'
        description='Evaluate a chess position (FEN) with Stockfish: returns the evaluation and best continuation.'
    )
    public static List<Result> analyze(List<Request> requests) {
        List<Result> out = new List<Result>();
        for (Request r : requests) {
            Map<String, Object> m = ChessCoachClient.postJson('/api/analyze', new Map<String, Object>{ 'fen' => r.fen });
            Result res = new Result();
            res.evaluation = ChessCoachClient.str(m.get('evaluation'));
            res.bestMove = ChessCoachClient.str(m.get('bestMove'));
            res.principalVariation = ChessCoachClient.str(m.get('principalVariation'));
            out.add(res);
        }
        return out;
    }
}
