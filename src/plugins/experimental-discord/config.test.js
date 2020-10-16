// @flow

import {type DiscordConfig, parser} from "./config";

describe("plugins/experimental-discord/config", () => {
  it("can load a basic config", () => {
    const raw = {
      guildId: "453243919774253079",
      reactionWeights: {
        "🥰": 4,
        ":sourcecred:626763367893303303": 16,
      },
      roleWeights: {
        "default": 0,
        "core:626763367893303303": 2,
        "contributor:456763457893303303": 1,
      },
      channelWeights: {
        "default": 0,
        "memes:743890898781339658": 0.25,
        "checkin:750011679852462220": 1,
      },
    };
    const parsed: DiscordConfig = parser.parseOrThrow(raw);
    expect(parsed).toEqual(raw);
  });
});
