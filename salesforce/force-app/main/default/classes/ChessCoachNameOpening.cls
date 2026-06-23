/**
 * Agent action: name the chess opening from a sequence of moves in SAN.
 */
public with sharing class ChessCoachNameOpening {

    public class Request {
        @InvocableVariable(
            label='Moves'
            description='Moves in SAN order, space- or comma-separated (e.g. "e4 e5 Nf3 Nc6 Bb5")'
            required=true
        )
        public String moves;
    }

    public class Result {
        @InvocableVariable(label='Opening' description='Recognized opening name')
        public String opening;
    }

    @InvocableMethod(
        label='Name Chess Opening'
        description='Name the opening from a sequence of moves in SAN.'
    )
    public static List<Result> nameOpening(List<Request> requests) {
        List<Result> out = new List<Result>();
        for (Request r : requests) {
            List<String> moveList = new List<String>();
            if (String.isNotBlank(r.moves)) {
                for (String tok : r.moves.replace(',', ' ').split('\\s+')) {
                    if (String.isNotBlank(tok)) moveList.add(tok.trim());
                }
            }
            Map<String, Object> m = ChessCoachClient.postJson(
                '/api/name-opening', new Map<String, Object>{ 'moves' => moveList });
            Result res = new Result();
            res.opening = ChessCoachClient.str(m.get('opening'));
            out.add(res);
        }
        return out;
    }
}
