/**
 * Agent action: return the engine's best move (SAN) for a position (FEN).
 */
public with sharing class ChessCoachBestMove {

    public class Request {
        @InvocableVariable(label='FEN' description='Position in FEN' required=true)
        public String fen;
    }

    public class Result {
        @InvocableVariable(label='Best Move' description='Engine best move in SAN')
        public String bestMove;
    }

    @InvocableMethod(
        label='Get Best Chess Move'
        description='Return the engine best move (SAN) for a position (FEN).'
    )
    public static List<Result> getBestMove(List<Request> requests) {
        List<Result> out = new List<Result>();
        for (Request r : requests) {
            Map<String, Object> m = ChessCoachClient.postJson('/api/best-move', new Map<String, Object>{ 'fen' => r.fen });
            Result res = new Result();
            res.bestMove = ChessCoachClient.str(m.get('bestMove'));
            out.add(res);
        }
        return out;
    }
}
