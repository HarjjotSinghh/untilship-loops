# Tally turns three bank exports into one month-end summary in 0.4 seconds

If you do your own books, month-end probably looks like this: export a CSV from each bank,
fix the columns by hand, paste everything into a spreadsheet and build the same pivot table
you built last month. For most of our beta users that took about two hours.

Tally is a command-line tool that does that part for you. Point it at the CSV files your
banks already give you and it prints a monthly summary: spending by category, by merchant
and by account, plus the transactions it could not categorise so you can fix them once.

    tally summarize ~/Downloads/*.csv --month 2026-09

It is fast enough that you stop thinking about it. Ten thousand transactions take 0.4
seconds on a laptop, and nothing leaves your machine.

We ran a three-month beta with 312 freelancers and indie founders. The median user went from
two hours of month-end work to nine minutes. The most common feedback was that they finally
did their books on the first of the month instead of the fifteenth.

Tally 1.0 reads exports from the twelve most common bank formats, and adding a new format is
a ten-line config file. It is free for personal use.

Try it on last month's exports and tell us which bank format we should support next:
https://tally.example.com
