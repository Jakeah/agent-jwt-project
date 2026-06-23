/**
 * Tests for the four Chess Coach engine actions + the shared ChessCoachClient. Uses an
 * HttpCalloutMock so no live callout is made — asserts each REST response shape parses into the
 * invocable result objects correctly.
 */
@isTest
private class ChessCoachAnalysisTest {

    private class Mock implements HttpCalloutMock {
        private String body;
        Mock(String body) { this.body = body; }
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setHeader('Content-Type', 'application/json');
            res.setBody(body);
            return res;
        }
    }

    @isTest
    static void analyzeParses() {
        Test.setMock(HttpCalloutMock.class, new Mock(
            '{"evaluation":"+0.40 (White is better)","evaluationCp":40,"bestMove":"e4",' +
            '"bestMoveUci":"e2e4","principalVariation":"e2e4 e7e5 g1f3","sideToMove":"White","depth":14}'));
        ChessCoachAnalyzePosition.Request r = new ChessCoachAnalyzePosition.Request();
        r.fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

        Test.startTest();
        List<ChessCoachAnalyzePosition.Result> out =
            ChessCoachAnalyzePosition.analyze(new List<ChessCoachAnalyzePosition.Request>{ r });
        Test.stopTest();

        System.assertEquals('e4', out[0].bestMove);
        System.assert(out[0].evaluation.contains('White is better'));
        System.assert(out[0].principalVariation.contains('e2e4'));
    }

    @isTest
    static void bestMoveParses() {
        Test.setMock(HttpCalloutMock.class, new Mock('{"bestMove":"Nf3","bestMoveUci":"g1f3"}'));
        ChessCoachBestMove.Request r = new ChessCoachBestMove.Request();
        r.fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

        Test.startTest();
        List<ChessCoachBestMove.Result> out =
            ChessCoachBestMove.getBestMove(new List<ChessCoachBestMove.Request>{ r });
        Test.stopTest();

        System.assertEquals('Nf3', out[0].bestMove);
    }

    @isTest
    static void judgeMoveParses() {
        Test.setMock(HttpCalloutMock.class, new Mock(
            '{"playedMove":"f6","engineBestMove":"e5","verdict":"mistake","evalSwingCp":150,"evalBefore":"+0.20"}'));
        ChessCoachJudgeMove.Request r = new ChessCoachJudgeMove.Request();
        r.fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
        r.move = 'f6';

        Test.startTest();
        List<ChessCoachJudgeMove.Result> out =
            ChessCoachJudgeMove.judge(new List<ChessCoachJudgeMove.Request>{ r });
        Test.stopTest();

        System.assertEquals('mistake', out[0].verdict);
        System.assertEquals('150', out[0].evalSwingCp);
        System.assertEquals('e5', out[0].engineBestMove);
    }

    @isTest
    static void nameOpeningSplitsAndParses() {
        Test.setMock(HttpCalloutMock.class, new Mock('{"opening":"Ruy López (Spanish Opening)"}'));
        ChessCoachNameOpening.Request r = new ChessCoachNameOpening.Request();
        r.moves = 'e4 e5 Nf3 Nc6 Bb5';

        Test.startTest();
        List<ChessCoachNameOpening.Result> out =
            ChessCoachNameOpening.nameOpening(new List<ChessCoachNameOpening.Request>{ r });
        Test.stopTest();

        System.assert(out[0].opening.contains('Ruy'));
    }

    @isTest
    static void errorResponseDoesNotBlowUp() {
        Test.setMock(HttpCalloutMock.class, new Mock('{"error":"Illegal or unparseable move: zz"}'));
        ChessCoachJudgeMove.Request r = new ChessCoachJudgeMove.Request();
        r.fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
        r.move = 'zz';

        Test.startTest();
        List<ChessCoachJudgeMove.Result> out =
            ChessCoachJudgeMove.judge(new List<ChessCoachJudgeMove.Request>{ r });
        Test.stopTest();

        System.assertEquals(1, out.size());
        System.assertEquals('', out[0].verdict);
    }
}
