import { Server, Socket } from "socket.io";
import { type Poll, type PollOption, type Vote } from "./_types.js";
import { PollEvents } from "./_enums.js";
import { randomUUID } from "crypto";

const activePolls: Map<string, Poll> = new Map();

export class PollService {
  socket: Socket;
  io: Server;
  userId: string;

  constructor(socket: Socket, io: Server, userId: string) {
    this.socket = socket;
    this.io = io;
    this.userId = userId;
  }

  listenForPollEvents() {
    this.listenForCreatePoll();
    this.listenForSubmitVote();
    this.listenForClosePoll();
  }

  private listenForCreatePoll() {
    this.socket.on(
      PollEvents.CREATE_POLL,
      (pollData: {
        question: string;
        options: string[];
        creatorId: string;
        creatorName: string;
        allowMultiple?: boolean;
      }) => {
        const pollOptions: PollOption[] = pollData.options.map((option) => ({
          id: randomUUID(),
          text: option,
          votes: 0,
        }));

        const completePoll: Poll = {
          id: randomUUID(),
          question: pollData.question,
          options: pollOptions,
          creatorId: pollData.creatorId,
          creatorName: pollData.creatorName,
          createdAt: new Date(),
          isActive: true,
          allowMultiple: pollData.allowMultiple || false,
          totalVotes: 0,
          voters: [],
        };

        activePolls.set(completePoll.id, completePoll);

        this.io.emit(PollEvents.NEW_POLL, completePoll);

        console.log(
          `Poll created by ${pollData.creatorName} (userId: ${pollData.creatorId}): ${pollData.question}`,
        );
      },
    );
  }

  private listenForSubmitVote() {
    this.socket.on(PollEvents.SUBMIT_VOTE, (voteData: Partial<Vote>) => {
      const poll = activePolls.get(voteData.pollId!);

      if (!poll) {
        console.error("Poll not found:", voteData.pollId);
        return;
      }

      if (!poll.isActive) {
        console.error("Poll is closed:", voteData.pollId);
        return;
      }

      const voterId = voteData.userId || this.socket.id;

      if (poll.voters.includes(voterId)) {
        console.log("User already voted:", voterId);
        return;
      }

      const optionIds = voteData.optionIds || [];
      let votesRecorded = 0;

      optionIds.forEach((optionId) => {
        const option = poll.options.find((opt) => opt.id === optionId);
        if (option) {
          option.votes++;
          votesRecorded++;
        }
      });

      if (votesRecorded > 0) {
        poll.voters.push(voterId);
        poll.totalVotes = poll.voters.length;
        activePolls.set(poll.id, poll);

        this.io.emit(PollEvents.POLL_UPDATED, {
          pollId: poll.id,
          options: poll.options,
          totalVotes: poll.totalVotes,
        });

        console.log(
          `Vote recorded for poll ${poll.id}, ${votesRecorded} option(s) selected, total voters: ${poll.totalVotes}`,
        );
      }
    });
  }

  private listenForClosePoll() {
    this.socket.on(
      PollEvents.CLOSE_POLL,
      (data: { pollId: string; userId: string }) => {
        const poll = activePolls.get(data.pollId);

        if (!poll) {
          console.error("Poll not found:", data.pollId);
          return;
        }

        if (poll.creatorId !== data.userId) {
          console.error(
            `Only poll creator can close the poll. Creator: ${poll.creatorId}, Requester: ${data.userId}`,
          );
          return;
        }

        poll.isActive = false;
        activePolls.set(poll.id, poll);

        this.io.emit(PollEvents.POLL_CLOSED, {
          pollId: poll.id,
        });

        console.log(`Poll closed by creator (userId: ${data.userId}): ${poll.id}`);
      },
    );
  }

  cleanupPollsOnDisconnect() {
    const pollsToDelete: string[] = [];

    activePolls.forEach((poll, pollId) => {
      if (poll.creatorId === this.userId) {
        poll.isActive = false;

        this.io.emit(PollEvents.POLL_CLOSED, {
          pollId: poll.id,
        });

        pollsToDelete.push(pollId);
        console.log(
          `Poll ${pollId} closed and deleted due to creator disconnect (userId: ${this.userId})`,
        );
      }
    });

    pollsToDelete.forEach((pollId) => {
      activePolls.delete(pollId);
    });

    if (pollsToDelete.length > 0) {
      console.log(
        `Cleaned up ${pollsToDelete.length} poll(s) for disconnected user (userId: ${this.userId})`,
      );
    }
  }
}
