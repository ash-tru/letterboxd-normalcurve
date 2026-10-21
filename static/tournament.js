const TournamentSort = (() => {
  function advance(draft) {
    while (draft.lists.length > 1) {
      const left = draft.lists[draft.cursor];
      const right = draft.lists[draft.cursor + 1];
      if (!left) {
        draft.lists = draft.nextLists;
        draft.nextLists = [];
        draft.cursor = 0;
        continue;
      }
      if (!right) {
        draft.nextLists.push(left);
        draft.cursor += 2;
        continue;
      }
      if (draft.leftIndex === left.length || draft.rightIndex === right.length) {
        draft.merged.push(...left.slice(draft.leftIndex), ...right.slice(draft.rightIndex));
        draft.nextLists.push(draft.merged);
        draft.merged = [];
        draft.leftIndex = 0;
        draft.rightIndex = 0;
        draft.cursor += 2;
        continue;
      }
      return;
    }
  }

  function start(username, slugs, random = Math.random) {
    const shuffled = [...slugs];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const draft = {
      username,
      sourceSlugs: [...slugs],
      lists: shuffled.map((slug) => [slug]),
      nextLists: [],
      cursor: 0,
      leftIndex: 0,
      rightIndex: 0,
      merged: [],
      comparisons: 0,
    };
    advance(draft);
    enableUndo(draft);
    return draft;
  }

  function enableUndo(draft) {
    if (draft.undoBase && Array.isArray(draft.history)) return;
    draft.undoBase = JSON.parse(JSON.stringify(draft));
    draft.history = [];
  }

  function pair(draft) {
    if (draft.lists.length <= 1) return null;
    return [
      draft.lists[draft.cursor][draft.leftIndex],
      draft.lists[draft.cursor + 1][draft.rightIndex],
    ];
  }

  function choose(draft, winner) {
    const current = pair(draft);
    if (!current || !current.includes(winner)) {
      throw new Error("Invalid tournament choice.");
    }
    draft.merged.push(winner);
    if (winner === current[0]) draft.leftIndex += 1;
    else draft.rightIndex += 1;
    draft.comparisons += 1;
    advance(draft);
    draft.history.push(winner);
  }

  function undo(draft) {
    if (!draft.history?.length || !draft.undoBase) return false;
    const choices = draft.history.slice(0, -1);
    const base = draft.undoBase;
    Object.assign(draft, JSON.parse(JSON.stringify(base)), { undoBase: base, history: [] });
    for (const winner of choices) choose(draft, winner);
    return true;
  }

  function matches(draft, username, slugs) {
    return draft && draft.username === username &&
      Array.isArray(draft.sourceSlugs) &&
      draft.sourceSlugs.length === slugs.length &&
      draft.sourceSlugs.every((slug, i) => slug === slugs[i]);
  }

  function remaining(draft) {
    const current = [];
    let minimum = 0;
    let maximum = 0;
    let nextSizes = draft.nextLists.map((list) => list.length);

    for (let i = draft.cursor; i < draft.lists.length; i += 2) {
      const left = draft.lists[i];
      const right = draft.lists[i + 1];
      if (!right) {
        nextSizes.push(left.length);
        continue;
      }
      const leftRemaining = left.slice(i === draft.cursor ? draft.leftIndex : 0);
      const rightRemaining = right.slice(i === draft.cursor ? draft.rightIndex : 0);
      const min = Math.min(leftRemaining.length, rightRemaining.length);
      const max = leftRemaining.length + rightRemaining.length - 1;
      current.push({ left: leftRemaining, right: rightRemaining, min, max });
      minimum += min;
      maximum += max;
      nextSizes.push(left.length + right.length);
    }

    const future = [];
    while (nextSizes.length > 1) {
      const following = [];
      let min = 0;
      let max = 0;
      let groups = 0;
      for (let i = 0; i < nextSizes.length; i += 2) {
        const left = nextSizes[i];
        const right = nextSizes[i + 1];
        if (right === undefined) {
          following.push(left);
          continue;
        }
        min += Math.min(left, right);
        max += left + right - 1;
        groups += 1;
        following.push(left + right);
      }
      future.push({ groups, min, max });
      minimum += min;
      maximum += max;
      nextSizes = following;
    }
    return { current, future, minimum, maximum };
  }

  return { start, pair, choose, undo, enableUndo, matches, remaining };
})();

if (typeof module !== "undefined") module.exports = TournamentSort;
