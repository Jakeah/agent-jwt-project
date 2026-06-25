/**
 * Tests for ChessCoachGetLiveGame — the verified-coach live-game pull. Mocks the Rails callout so
 * no live HTTP is made; seeds a Contact so the Contact-id → email hop is exercised. Asserts the
 * Rails JSON shape parses into the invocable Result and that the no-game / no-email / error paths
 * degrade gracefully (the agent should get a usable summary, never an exception).
 */
@isTest
private class ChessCoachGetLiveGameTest {

    private class Mock implements HttpCalloutMock {
        private Integer code;
        private String body;
        Mock(Integer code, String body) { this.code = code; this.body = body; }
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(code);
            res.setHeader('Content-Type', 'application/json');
            res.setBody(body);
            return res;
        }
    }

    private static Id seedContact() {
        Contact c = new Contact(LastName = 'Player', FirstName = 'Jordan', Email = 'player@example.com');
        insert c;
        return c.Id;
    }

    @isTest
    static void parsesLiveGame() {
        Id contactId = seedContact();
        Test.setMock(HttpCalloutMock.class, new Mock(200,
            '{"found":true,"gameId":42,"fen":"rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",' +
            '"pgn":"1. e4 c5","lastMove":"c5","turn":"White","moveCount":1,"status":"active"}'));

        ChessCoachGetLiveGame.Request r = new ChessCoachGetLiveGame.Request();
        r.contactId = contactId;

        Test.startTest();
        List<ChessCoachGetLiveGame.Result> out =
            ChessCoachGetLiveGame.getLiveGame(new List<ChessCoachGetLiveGame.Request>{ r });
        Test.stopTest();

        System.assertEquals(true, out[0].found);
        System.assertEquals('White', out[0].turn);
        System.assertEquals('1', out[0].moveCount);
        System.assertEquals('c5', out[0].lastMove);
        System.assert(out[0].fen.startsWith('rnbqkbnr/pp1ppppp'));
        System.assert(out[0].summary.contains('White to move'), 'summary: ' + out[0].summary);
        System.assert(out[0].summary.contains('1. e4 c5'));
    }

    @isTest
    static void emailInputIsUsedDirectlyWithoutContactLookup() {
        // The primary path: email passed straight from prechat, NO contactId, NO Contact seeded.
        Test.setMock(HttpCalloutMock.class, new Mock(200,
            '{"found":true,"fen":"rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",' +
            '"pgn":"1. e4 c5","turn":"White","moveCount":1,"status":"active"}'));
        ChessCoachGetLiveGame.Request r = new ChessCoachGetLiveGame.Request();
        r.email = 'jacob.connors3@gmail.com';

        Test.startTest();
        List<ChessCoachGetLiveGame.Result> out =
            ChessCoachGetLiveGame.getLiveGame(new List<ChessCoachGetLiveGame.Request>{ r });
        Test.stopTest();

        System.assertEquals(true, out[0].found);
        System.assertEquals('White', out[0].turn);
        System.assert(out[0].summary.contains('White to move'), 'summary: ' + out[0].summary);
    }

    @isTest
    static void handlesNoActiveGame() {
        Id contactId = seedContact();
        Test.setMock(HttpCalloutMock.class, new Mock(200, '{"found":false,"reason":"player has no games"}'));

        ChessCoachGetLiveGame.Request r = new ChessCoachGetLiveGame.Request();
        r.contactId = contactId;

        Test.startTest();
        List<ChessCoachGetLiveGame.Result> out =
            ChessCoachGetLiveGame.getLiveGame(new List<ChessCoachGetLiveGame.Request>{ r });
        Test.stopTest();

        System.assertEquals(false, out[0].found);
        System.assert(out[0].summary.contains('No active game'), 'summary: ' + out[0].summary);
    }

    @isTest
    static void blankContactDoesNotCallout() {
        // No mock set: if this tried to call out, the test would fail with an unmocked-callout error.
        ChessCoachGetLiveGame.Request r = new ChessCoachGetLiveGame.Request();
        r.contactId = '';

        Test.startTest();
        List<ChessCoachGetLiveGame.Result> out =
            ChessCoachGetLiveGame.getLiveGame(new List<ChessCoachGetLiveGame.Request>{ r });
        Test.stopTest();

        System.assertEquals(false, out[0].found);
        System.assert(out[0].summary.contains('No verified player email'), 'summary: ' + out[0].summary);
    }

    @isTest
    static void contactWithoutEmailDegradesGracefully() {
        Contact c = new Contact(LastName = 'NoEmail');
        insert c;

        ChessCoachGetLiveGame.Request r = new ChessCoachGetLiveGame.Request();
        r.contactId = c.Id;

        Test.startTest();
        List<ChessCoachGetLiveGame.Result> out =
            ChessCoachGetLiveGame.getLiveGame(new List<ChessCoachGetLiveGame.Request>{ r });
        Test.stopTest();

        System.assertEquals(false, out[0].found);
        System.assert(out[0].summary.contains('No verified player email'), 'summary: ' + out[0].summary);
    }

    @isTest
    static void errorBodyDoesNotBlowUp() {
        Id contactId = seedContact();
        Test.setMock(HttpCalloutMock.class, new Mock(401, '{"error":"unauthorized"}'));

        ChessCoachGetLiveGame.Request r = new ChessCoachGetLiveGame.Request();
        r.contactId = contactId;

        Test.startTest();
        List<ChessCoachGetLiveGame.Result> out =
            ChessCoachGetLiveGame.getLiveGame(new List<ChessCoachGetLiveGame.Request>{ r });
        Test.stopTest();

        System.assertEquals(1, out.size());
        System.assertEquals(false, out[0].found);
        System.assert(out[0].summary.contains('error'), 'summary: ' + out[0].summary);
    }
}
