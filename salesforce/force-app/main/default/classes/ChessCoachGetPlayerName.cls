/**
 * Looks up the verified player's first name from their Contact so the chess coach can greet
 * them personally. The Contact id comes from the MessagingEndUser, which is populated by MIAW
 * User Verification once the RS256 identity token is accepted.
 */
public with sharing class ChessCoachGetPlayerName {
    public class Request {
        @InvocableVariable(
            label='Contact Id'
            description='Id of the verified player\'s Contact'
            required=true
        )
        public String contactId;
    }

    public class Result {
        @InvocableVariable(
            label='First Name'
            description='The player\'s first name for a personal greeting'
        )
        public String firstName;
    }

    @InvocableMethod(
        label='Get Player Name'
        description='Returns the first name of the verified player from their Contact'
    )
    public static List<Result> getPlayerName(List<Request> requests) {
        List<Result> results = new List<Result>();
        for (Request req : requests) {
            Result r = new Result();
            r.firstName = '';
            if (String.isNotBlank(req.contactId)) {
                List<Contact> contacts = [
                    SELECT FirstName FROM Contact WHERE Id = :req.contactId LIMIT 1
                ];
                if (!contacts.isEmpty() && contacts[0].FirstName != null) {
                    r.firstName = contacts[0].FirstName;
                }
            }
            results.add(r);
        }
        return results;
    }
}
