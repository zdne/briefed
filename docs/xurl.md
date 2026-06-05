# xurl setup guide

Upadted 5th Jun 2026

Note: currently not used in the pnd

1. create an app at https://deloper.x.com/en/portal/dashboard
2. add user auth in it, note the `client id` and `client secret`, use `http://localhost:8080/callback` as redirect URI
3. install xurl (using brew)
4. add the app locally `xurl auth apps add <app name> --client-id <XXXXXXXXXXXXpjaQ> --client-secret <XXXXXXXXXXXX-lmE>`
5. authenticate as a user `xurl auth oauth2 --app <app-name>`                                                                                                       
6. set as default `xurl auth default <app-name>`
7. verify `xurl whoami`

output example:

```json 
{
  "data":[
    {
      "text":"I was tired of reading long Claude reports so I tried this \"oval office briefing\" prompt. No regrets, worked like a charm :) https://t.co/mG7HKLlZc8",
      "edit_history_tweet_ids":[
        "2062875508879110287"
      ],
      "id":"2062875508879110287"
    },
    {
      "text":"Sharing the playbook that turned years of failure into an $8m acquisition and multiple $100k+ MRR SaaS creations\n\nactionable growth tactic\nbehind-the-scene stories\nno sponsors • no ads • always free\n\nJoin 75k+ founders \u0026amp; makers here → https://t.co/sM8DL3hugy\n\nSee you in your",
      "edit_history_tweet_ids":[
        "2062868323453247988"
      ],
      "id":"2062868323453247988"
    },
    {
      "text":"It took years in Coolify to go from the huge menu (first image) on mobile to a responsive, better for mobile view (second / third image).\n\nYour app is fine without being responsive / mobile first. https://t.co/euuwGcrl5q",
      "edit_history_tweet_ids":[
        "2062866864406229382"
      ],
      "id":"2062866864406229382"
    },
    {
      "text":"RT @shensi: Copilot just got the keys to hundreds of your tools.\n\nToday, I'm excited to announce Agent Handler is coming to the Microsoft A…",
      "edit_history_tweet_ids":[
        "2062866237579796895"
      ],
      "id":"2062866237579796895"
    },
    {
      "text":"One of the most powerful moments in this episode.\n\nAt 28, @markpinc finds himself unemployed (fired by John Malone, Bain, and others), with few prospects. He had big dreams, but the world wasn't cooperating.\n\nThis is how he turned things around. \nwhat\n\"I realized I had nowhere https://t.co/wXhCmjjynt https://t.co/FieKOxOGJw",
      "edit_history_tweet_ids":[
        "2062863253680603447"
      ],
      "id":"2062863253680603447"
    },
    {
      "text":"\uD83C\uDDFA\uD83C\uDDF8 We’re in New York for @Vault__Summit, where Guillaume Chatain, our Head of Institutional Sales, is a panel speaker.\n\nAttending? Join us\n\nPanel: Curator Accountability: Track Records, Transparency and the Evaluation Gap\n\n\uD83D\uDCC5 June 5\n\uD83D\uDD5712:30pm EDT https://t.co/cdN09YV8CD",
      "edit_history_tweet_ids":[
        "2062861180075466887"
      ],
      "id":"2062861180075466887"
    },
    {
      "text":"RT @minchoi: Hollywood will never be the same...\n\nSeedance 2.0\n\n10 wild examples:",
      "edit_history_tweet_ids":[
        "2062858232683471114"
      ],
      "id":"2062858232683471114"
    },
    {
      "text":"RT @minchoi: I created the entire video sequence for this MV with Dreamina AI with Octo \u0026amp; Dreamina Seedance 2.0.\n\nIt stays in sync with you…",
      "edit_history_tweet_ids":[
        "2062858219203051677"
      ],
      "id":"2062858219203051677"
    },
    {
      "text":"RT @minchoi: AI is starting to build AI.\n\nAnthropic just published one of the clearest signals yet.\n\nClaude now writes 80%+ of Anthropic's…",
      "edit_history_tweet_ids":[
        "2062858187275989140"
      ],
      "id":"2062858187275989140"
    },
    {
      "text":"RT @minchoi: Google just dropped Gemma 4 12B.\n\nThis AI multimodal model runs locally on your laptop without heavy encoder stack.\n\nVision. A…",
      "edit_history_tweet_ids":[
        "2062858172029694140"
      ],
      "id":"2062858172029694140"
    }
  ],
  "meta":{
    "next_token":"7140dibdnow9c7btwoxiixrsarqavaczrum24vmzffrjk",
    "result_count":10,
    "newest_id":"2062875508879110287",
    "oldest_id":"2062858172029694140"
  }
}
```