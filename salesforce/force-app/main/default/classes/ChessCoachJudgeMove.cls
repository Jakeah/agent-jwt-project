/**
 * Agent action: judge a played move vs. the engine's best. Returns a verdict (best/good/
 * inaccuracy/mistake/blunder), the evaluation swing in centipawns, and the engine's best move.
 */
public with sharing class ChessCoachJudgeMove {

    public class Request {
        @InvocableVariable(
            label='FEN Before Move'
            description='Position BEFORE the move, in FEN'
            required=true
        )
        public String fen;
        @InvocableVariable(
            label='Move'
            description='The move played, in SAN or UCI'
            required=true
        )
        public String move;
    }

    public class Result {
        @InvocableVariable(label='Verdict' description='best / good / inaccuracy / mistake / blunder')
        public String verdict;
        @InvocableVariable(label='Eval Swing (cp)' description='Centipawns lost by the move (higher = worse)')
        public String evalSwingCp;
        @InvocableVariable(label='Engine Best Move' description='What the engine preferred, in SAN')
        public String engineBestMove;
    }

    @InvocableMethod(
        label='Judge Chess Move'
        description='Judge a played move against the engine best: returns a verdict and the evaluation swing.'
    )
    public static List<Result> judge(List<Request> requests) {
        List<Result> out = new List<Result>();
        for (Request r : requests) {
            Map<String, Object> m = ChessCoachClient.postJson(
                '/api/explain-move', new Map<String, Object>{ 'fen' => r.fen, 'move' => r.move });
            Result res = new Result();
            res.verdict = ChessCoachClient.str(m.get('verdict'));
            res.engineBestMove = ChessCoachClient.str(m.get('engineBestMove'));
            res.evalSwingCp = ChessCoachClient.str(m.get('evalSwingCp'));
            out.add(res);
        }
        return out;
    }
}
