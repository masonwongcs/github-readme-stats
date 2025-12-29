// @ts-check

import axios from "axios";
import * as dotenv from "dotenv";
import githubUsernameRegex from "github-username-regex";
import { calculateRank } from "../calculateRank.js";
import { retryer } from "../common/retryer.js";
import { logger } from "../common/log.js";
import { excludeRepositories } from "../common/envs.js";
import { CustomError, MissingParamError } from "../common/error.js";
import { wrapTextMultiline } from "../common/fmt.js";
import { request } from "../common/http.js";

dotenv.config();

// GraphQL queries.
const GRAPHQL_REPOS_FIELD = `
  repositories(first: 100, ownerAffiliations: OWNER, orderBy: {direction: DESC, field: STARGAZERS}, after: $after) {
    totalCount
    nodes {
      name
      stargazers {
        totalCount
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
`;

const GRAPHQL_REPOS_QUERY = `
  query userInfo($login: String!, $after: String) {
    user(login: $login) {
      ${GRAPHQL_REPOS_FIELD}
    }
  }
`;

const GRAPHQL_STATS_QUERY = `
  query userInfo($login: String!, $after: String, $includeMergedPullRequests: Boolean!, $includeDiscussions: Boolean!, $includeDiscussionsAnswers: Boolean!, $startTime: DateTime = null) {
    user(login: $login) {
      name
      login
      commits: contributionsCollection (from: $startTime) {
        totalCommitContributions,
      }
      reviews: contributionsCollection {
        totalPullRequestReviewContributions
      }
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
      repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
        totalCount
      }
      pullRequests(first: 1) {
        totalCount
      }
      mergedPullRequests: pullRequests(states: MERGED) @include(if: $includeMergedPullRequests) {
        totalCount
      }
      openIssues: issues(states: OPEN) {
        totalCount
      }
      closedIssues: issues(states: CLOSED) {
        totalCount
      }
      followers {
        totalCount
      }
      repositoryDiscussions @include(if: $includeDiscussions) {
        totalCount
      }
      repositoryDiscussionComments(onlyAnswers: true) @include(if: $includeDiscussionsAnswers) {
        totalCount
      }
      ${GRAPHQL_REPOS_FIELD}
    }
  }
`;

/**
 * Stats fetcher object.
 *
 * @param {object & { after: string | null }} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 */
const fetcher = (variables, token) => {
  const query = variables.after ? GRAPHQL_REPOS_QUERY : GRAPHQL_STATS_QUERY;
  return request(
    {
      query,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

/**
 * Fetch stats information for a given username.
 *
 * @param {object} variables Fetcher variables.
 * @param {string} variables.username GitHub username.
 * @param {boolean} variables.includeMergedPullRequests Include merged pull requests.
 * @param {boolean} variables.includeDiscussions Include discussions.
 * @param {boolean} variables.includeDiscussionsAnswers Include discussions answers.
 * @param {string|undefined} variables.startTime Time to start the count of total commits.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 *
 * @description This function supports multi-page fetching if the 'FETCH_MULTI_PAGE_STARS' environment variable is set to true.
 */
const statsFetcher = async ({
  username,
  includeMergedPullRequests,
  includeDiscussions,
  includeDiscussionsAnswers,
  startTime,
}) => {
  let stats;
  let hasNextPage = true;
  let endCursor = null;
  while (hasNextPage) {
    const variables = {
      login: username,
      first: 100,
      after: endCursor,
      includeMergedPullRequests,
      includeDiscussions,
      includeDiscussionsAnswers,
      startTime,
    };
    let res = await retryer(fetcher, variables);
    if (res.data.errors) {
      return res;
    }

    // Store stats data.
    const repoNodes = res.data.data.user.repositories.nodes;
    if (stats) {
      stats.data.data.user.repositories.nodes.push(...repoNodes);
    } else {
      stats = res;
    }

    // Disable multi page fetching on public Vercel instance due to rate limits.
    const repoNodesWithStars = repoNodes.filter(
      (node) => node.stargazers.totalCount !== 0,
    );
    hasNextPage =
      process.env.FETCH_MULTI_PAGE_STARS === "true" &&
      repoNodes.length === repoNodesWithStars.length &&
      res.data.data.user.repositories.pageInfo.hasNextPage;
    endCursor = res.data.data.user.repositories.pageInfo.endCursor;
  }

  return stats;
};

/**
 * Fetch total commits using the REST API.
 *
 * @param {object} variables Fetcher variables.
 * @param {string} token GitHub token.
 * @returns {Promise<import('axios').AxiosResponse>} Axios response.
 *
 * @see https://developer.github.com/v3/search/#search-commits
 */
const fetchTotalCommits = (variables, token) => {
  return axios({
    method: "get",
    url: `https://api.github.com/search/commits?q=author:${variables.login}`,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.github.cloak-preview",
      Authorization: `token ${token}`,
    },
  });
};

/**
 * Fetch all the commits for all the repositories of a given username.
 *
 * @param {string} username GitHub username.
 * @returns {Promise<number>} Total commits.
 *
 * @description Done like this because the GitHub API does not provide a way to fetch all the commits. See
 * #92#issuecomment-661026467 and #211 for more information.
 */
const totalCommitsFetcher = async (username) => {
  if (!githubUsernameRegex.test(username)) {
    logger.log("Invalid username provided.");
    throw new Error("Invalid username provided.");
  }

  let res;
  try {
    res = await retryer(fetchTotalCommits, { login: username });
  } catch (err) {
    logger.log(err);
    throw new Error(err);
  }

  const totalCount = res.data.total_count;
  if (!totalCount || isNaN(totalCount)) {
    throw new CustomError(
      "Could not fetch total commits.",
      CustomError.GITHUB_REST_API_ERROR,
    );
  }
  return totalCount;
};

/**
 * Calculate current and longest contribution streaks from contribution calendar.
 *
 * @param {Array} weeks Array of weeks with contribution days.
 * @returns {{currentStreak: number, longestStreak: number}} Streak data.
 */
const calculateStreaks = (weeks) => {
  if (!weeks || weeks.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  // Flatten all contribution days
  const allDays = [];
  for (const week of weeks) {
    if (week.contributionDays) {
      allDays.push(...week.contributionDays);
    }
  }

  if (allDays.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  // Sort days by date
  allDays.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Find days with contributions (contributionCount > 0)
  const contributionDates = allDays
    .filter((day) => day.contributionCount > 0)
    .map((day) => new Date(day.date))
    .map((date) => {
      // Normalize to midnight UTC to avoid timezone issues
      return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    });

  if (contributionDates.length === 0) {
    return { currentStreak: 0, longestStreak: 0 };
  }

  // Calculate longest streak
  let longestStreak = 1;
  let currentLongestStreak = 1;

  for (let i = 1; i < contributionDates.length; i++) {
    const prevDate = contributionDates[i - 1];
    const currDate = contributionDates[i];
    const daysDiff = Math.floor((currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));

    if (daysDiff === 1) {
      // Consecutive day
      currentLongestStreak++;
      longestStreak = Math.max(longestStreak, currentLongestStreak);
    } else {
      // Gap in contributions
      currentLongestStreak = 1;
    }
  }

  // Calculate current streak (from today backwards)
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  
  let currentStreak = 0;
  let checkDate = new Date(today);
  
  // Check if today has contributions
  const todayHasContributions = contributionDates.some(
    (date) => date.getTime() === today.getTime()
  );

  if (todayHasContributions) {
    currentStreak = 1;
    checkDate = new Date(today);
    checkDate.setUTCDate(checkDate.getUTCDate() - 1);
  } else {
    // Start from yesterday
    checkDate.setUTCDate(checkDate.getUTCDate() - 1);
  }

  // Count backwards from today/yesterday
  while (true) {
    const hasContributions = contributionDates.some(
      (date) => date.getTime() === checkDate.getTime()
    );

    if (hasContributions) {
      currentStreak++;
      checkDate.setUTCDate(checkDate.getUTCDate() - 1);
    } else {
      break;
    }
  }

  return {
    currentStreak,
    longestStreak,
  };
};

/**
 * Fetch stats for a given username.
 *
 * @param {string} username GitHub username.
 * @param {boolean} include_all_commits Include all commits.
 * @param {string[]} exclude_repo Repositories to exclude.
 * @param {boolean} include_merged_pull_requests Include merged pull requests.
 * @param {boolean} include_discussions Include discussions.
 * @param {boolean} include_discussions_answers Include discussions answers.
 * @param {number|undefined} commits_year Year to count total commits
 * @returns {Promise<import("./types").StatsData>} Stats data.
 */
const fetchStats = async (
  username,
  include_all_commits = false,
  exclude_repo = [],
  include_merged_pull_requests = false,
  include_discussions = false,
  include_discussions_answers = false,
  commits_year,
) => {
  if (!username) {
    throw new MissingParamError(["username"]);
  }

  const stats = {
    name: "",
    totalPRs: 0,
    totalPRsMerged: 0,
    mergedPRsPercentage: 0,
    totalReviews: 0,
    totalCommits: 0,
    totalIssues: 0,
    totalStars: 0,
    totalDiscussionsStarted: 0,
    totalDiscussionsAnswered: 0,
    contributedTo: 0,
    currentStreak: 0,
    longestStreak: 0,
    rank: { level: "C", percentile: 100 },
  };

  let res = await statsFetcher({
    username,
    includeMergedPullRequests: include_merged_pull_requests,
    includeDiscussions: include_discussions,
    includeDiscussionsAnswers: include_discussions_answers,
    startTime: commits_year ? `${commits_year}-01-01T00:00:00Z` : undefined,
  });

  // Catch GraphQL errors.
  if (res.data.errors) {
    logger.error(res.data.errors);
    if (res.data.errors[0].type === "NOT_FOUND") {
      throw new CustomError(
        res.data.errors[0].message || "Could not fetch user.",
        CustomError.USER_NOT_FOUND,
      );
    }
    if (res.data.errors[0].message) {
      throw new CustomError(
        wrapTextMultiline(res.data.errors[0].message, 90, 1)[0],
        res.statusText,
      );
    }
    throw new CustomError(
      "Something went wrong while trying to retrieve the stats data using the GraphQL API.",
      CustomError.GRAPHQL_ERROR,
    );
  }

  const user = res.data.data.user;

  stats.name = user.name || user.login;

  // if include_all_commits, fetch all commits using the REST API.
  if (include_all_commits) {
    stats.totalCommits = await totalCommitsFetcher(username);
  } else {
    stats.totalCommits = user.commits.totalCommitContributions;
  }

  stats.totalPRs = user.pullRequests.totalCount;
  if (include_merged_pull_requests) {
    stats.totalPRsMerged = user.mergedPullRequests.totalCount;
    stats.mergedPRsPercentage =
      (user.mergedPullRequests.totalCount / user.pullRequests.totalCount) *
        100 || 0;
  }
  stats.totalReviews = user.reviews.totalPullRequestReviewContributions;
  stats.totalIssues = user.openIssues.totalCount + user.closedIssues.totalCount;
  if (include_discussions) {
    stats.totalDiscussionsStarted = user.repositoryDiscussions.totalCount;
  }
  if (include_discussions_answers) {
    stats.totalDiscussionsAnswered =
      user.repositoryDiscussionComments.totalCount;
  }
  stats.contributedTo = user.repositoriesContributedTo.totalCount;

  // Calculate streaks from contribution calendar
  if (user.contributionsCollection?.contributionCalendar?.weeks) {
    const streaks = calculateStreaks(user.contributionsCollection.contributionCalendar.weeks);
    stats.currentStreak = streaks.currentStreak;
    stats.longestStreak = streaks.longestStreak;
  }

  // Retrieve stars while filtering out repositories to be hidden.
  const allExcludedRepos = [...exclude_repo, ...excludeRepositories];
  let repoToHide = new Set(allExcludedRepos);

  stats.totalStars = user.repositories.nodes
    .filter((data) => {
      return !repoToHide.has(data.name);
    })
    .reduce((prev, curr) => {
      return prev + curr.stargazers.totalCount;
    }, 0);

  stats.rank = calculateRank({
    all_commits: include_all_commits,
    commits: stats.totalCommits,
    prs: stats.totalPRs,
    reviews: stats.totalReviews,
    issues: stats.totalIssues,
    repos: user.repositories.totalCount,
    stars: stats.totalStars,
    followers: user.followers.totalCount,
  });

  return stats;
};

export { fetchStats };
export default fetchStats;
