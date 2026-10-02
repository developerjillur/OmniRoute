#!/usr/bin/perl
# omni-bind.pl OWNER ADDR:PORT[,ADDR:PORT...] -- COMMAND [ARGS...]
#
# Opens listening sockets on privileged ports WITHOUT blocking Local (Flywheel)'s router nginx.
# macOS refuses a non-root wildcard bind (nginx: *:80, *:443) while another uid owns a socket on the same port
# at a specific address; a socket's owner is the effective uid that CREATED it. So each socket is created with
# euid = OWNER (the user Local runs as), bound as root (needed for ports < 1024 on a specific address), and
# SO_REUSEADDR is set, which lets both orders work: ours first or nginx first.
# Then privileges drop to "nobody" and COMMAND is exec'd with the sockets inherited; their numbers are passed as
#   OMNI_LISTEN_FDS="fd@addr:port,fd@addr:port,..."
# Run as root from a LaunchDaemon. IPv6 addresses go in brackets: [fd6f:6d6e::2]:80
use strict;
use warnings;
use Socket qw(:DEFAULT inet_pton pack_sockaddr_in6 IPV6_V6ONLY IPPROTO_IPV6 AF_INET6 PF_INET6);
use POSIX ();
use Fcntl qw(F_SETFD);
my %s;

$^F = 1023;    # keep every descriptor opened from here on open across exec
die "omni-bind: must run as root\n" if $> != 0;
my ($owner, $specs, $sep, @cmd) = @ARGV;
die "usage: omni-bind.pl OWNER ADDR:PORT[,...] -- COMMAND [ARGS...]\n"
  unless defined $sep && $sep eq '--' && @cmd;
my ($ouid) = (getpwnam($owner))[2];
die "omni-bind: unknown user $owner\n" unless defined $ouid && $ouid != 0;

my @passed;
for my $spec (split /,/, $specs) {
  my ($addr, $port) = $spec =~ /^\[?([^\]]+?)\]?:(\d+)$/ or die "omni-bind: bad spec $spec\n";
  my $v6 = $addr =~ /:/;
  $> = $ouid;                                   # the socket now belongs to OWNER
  socket(my $s, $v6 ? PF_INET6 : PF_INET, SOCK_STREAM, 0) or die "omni-bind: socket $spec: $!\n";
  $> = 0;                                       # bind below 1024 on a specific address needs root
  setsockopt($s, SOL_SOCKET, SO_REUSEADDR, 1) or die "omni-bind: SO_REUSEADDR $spec: $!\n";
  setsockopt($s, IPPROTO_IPV6, IPV6_V6ONLY, 1) or die "omni-bind: V6ONLY $spec: $!\n" if $v6;
  my $sa = $v6 ? pack_sockaddr_in6($port, inet_pton(AF_INET6, $addr)) : pack_sockaddr_in($port, inet_aton($addr));
  # Connections the previous (root-owned) listener accepted linger for a while after it exits; while they do,
  # macOS reports EADDRINUSE for a socket of another owner. They clear within about a minute, so wait.
  my $deadline = time + 150;
  until (bind($s, $sa)) {
    die "omni-bind: bind $spec: $!\n" unless $!{EADDRINUSE} && time < $deadline;
    print "omni-bind: $spec busy (old connections closing), retrying\n" if !$s{retry}++;
    sleep 1;
  }
  listen($s, 511) or die "omni-bind: listen $spec: $!\n";
  fcntl($s, F_SETFD, 0);
  push @passed, [$s, $spec];
}

$ENV{OMNI_LISTEN_FDS} = join ',', map { fileno($_->[0]) . '@' . $_->[1] } @passed;
my ($nuid, $ngid) = (getpwnam('nobody'))[2, 3];
POSIX::setgid($ngid) or die "omni-bind: setgid: $!\n";
$) = "$ngid $ngid";
POSIX::setuid($nuid) or die "omni-bind: setuid: $!\n";
die "omni-bind: still privileged\n" if $< == 0 || $> == 0;
print "omni-bind: $ENV{OMNI_LISTEN_FDS} (socket owner $owner), running as nobody: @cmd\n";
exec { $cmd[0] } @cmd or die "omni-bind: exec $cmd[0]: $!\n";
