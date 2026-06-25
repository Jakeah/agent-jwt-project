/**
 * Returns the verified player's LIVE game state (current FEN/PGN/turn/move-count/status) by calling
 * back to the Rails app, keyed by the player's Contact email.
 *
 * WHY this exists (and why it's a callout, not a field read):
 * Hidden prechat fields are consumed only at conversation CREATION. A verified (User-Verification /
 * AUTH) user has ONE persistent conversation that every later chat-open RESUMES, so
 * setHiddenPrechatFields is a no-op after the first open and MessagingSession.Chess_*__c goes
 * stale/null. (See docs/miaw-prechat-to-agent-guide.md — "the verified-user continuity trap".) So
 * the coach can't rely on the messaging-session fields for a verified user. Instead it PULLS the
 * current board from the source of truth (the Rails game, persisted every move) each turn — which
 * makes continuity irrelevant and the coach always current.
 *
 * The Contact id comes from @MessagingEndUser.ContactId (set by MIAW User Verification once the
 * RS256 identity token is accepted, then resolved to a Contact by the routing flow). Auth to Rails
 * is handled by the ChessLiveGame Named/External Credential (it injects the bearer header) — this
 * class never sees the token.
 */
public with sharing class ChessCoachGetLiveGame {

    private static final String NAMED_CRED = 'callout:ChessLiveGame';

    public class Request {
        @InvocableVariable(
            label='Player Email'
            description='The signed-in player\'s email (from the Chess_Player_Email prechat field). Preferred identity key — pass this when available.'
        )
        public String email;

        @InvocableVariable(
            label='Contact Id'
            description='Fallback: Id of the verified player\'s Contact (from @MessagingEndUser.ContactId), used only if Player Email is blank.'
        )
        public String contactId;
    }

    public class Result {
        @InvocableVariable(label='Found' description='True if a live game was found for this player')
        public Boolean found;

        @InvocableVariable(label='FEN' description='Current position in Forsyth-Edwards Notation')
        public String fen;

        @InvocableVariable(label='PGN' description='Moves so far in Portable Game Notation')
        public String pgn;

        @InvocableVariable(label='Last Move' description='The most recent move in SAN (e.g. "Bxc6") — the move shown on screen, for grounding "was that a good move?"')
        public String lastMove;

        @InvocableVariable(label='Side To Move' description='"White" or "Black" — whose turn it is now')
        public String turn;

        @InvocableVariable(label='Moves Played' description='Number of full moves completed')
        public String moveCount;

        @InvocableVariable(label='Status' description='active | checkmate | stalemate | draw | resigned')
        public String status;

        @InvocableVariable(label='Summary' description='One-line natural-language summary for the coach')
        public String summary;
    }

    @InvocableMethod(
        label='Get Live Game'
        description='Fetches the verified player\'s current chess position (live, every turn) from the app, keyed by their Contact. Call this before analyzing "my position" so you reason about the CURRENT board, not the chat-open snapshot.'
    )
    public static List<Result> getLiveGame(List<Request> requests) {
        List<Result> results = new List<Result>();
        for (Request req : requests) {
            results.add(fetchOne(req));
        }
        return results;
    }

    private static Result fetchOne(Request req) {
        Result r = new Result();
        r.found = false;
        r.fen = '';
        r.pgn = '';
        r.lastMove = '';
        r.turn = '';
        r.moveCount = '';
        r.status = '';

        // Prefer the email passed straight from prechat (reliable); fall back to resolving it from
        // the Contact only if no email was supplied (@MessagingEndUser.ContactId arrives null in
        // agent context, which is why email-from-prechat is the primary path).
        String email = String.isNotBlank(req.email) ? req.email.trim() : emailForContact(req.contactId);
        if (String.isBlank(email)) {
            r.summary = 'No verified player email is available, so I can\'t look up the live game.';
            return r;
        }

        Map<String, Object> body = callRails(email);
        if (body == null) {
            r.summary = 'Could not reach the game service to read the live position.';
            return r;
        }
        if (body.get('error') != null) {
            r.summary = 'Game service error: ' + String.valueOf(body.get('error'));
            return r;
        }

        Boolean found = body.get('found') == true;
        r.found = found;
        if (!found) {
            r.summary = 'No active game found for this player right now.';
            return r;
        }

        r.fen = str(body.get('fen'));
        r.pgn = str(body.get('pgn'));
        r.lastMove = str(body.get('lastMove'));
        r.turn = str(body.get('turn'));
        r.moveCount = str(body.get('moveCount'));
        r.status = str(body.get('status'));
        r.summary = buildSummary(r);
        return r;
    }

    private static String emailForContact(String contactId) {
        if (String.isBlank(contactId)) {
            return null;
        }
        List<Contact> contacts = [SELECT Email FROM Contact WHERE Id = :contactId LIMIT 1];
        return contacts.isEmpty() ? null : contacts[0].Email;
    }

    private static Map<String, Object> callRails(String email) {
        HttpRequest httpReq = new HttpRequest();
        httpReq.setEndpoint(NAMED_CRED + '/coach/game_state?email=' + EncodingUtil.urlEncode(email, 'UTF-8'));
        httpReq.setMethod('GET');
        httpReq.setHeader('Accept', 'application/json');
        httpReq.setTimeout(30000);
        HttpResponse res = new Http().send(httpReq);
        Object parsed = JSON.deserializeUntyped(res.getBody());
        return parsed instanceof Map<String, Object> ? (Map<String, Object>) parsed : null;
    }

    private static String buildSummary(Result r) {
        String s = 'Live game: ' + r.turn + ' to move';
        if (String.isNotBlank(r.moveCount)) {
            s += ' after ' + r.moveCount + ' full move' + (r.moveCount == '1' ? '' : 's');
        }
        s += '. FEN: ' + r.fen;
        if (String.isNotBlank(r.pgn)) {
            s += '. Moves: ' + r.pgn;
        }
        if (String.isNotBlank(r.status) && r.status != 'active') {
            s += '. Game is ' + r.status + '.';
        }
        return s;
    }

    private static String str(Object o) {
        return o == null ? '' : String.valueOf(o);
    }
}
