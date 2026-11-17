import ipaddress
import re
import uuid


class IsolationUnproven(RuntimeError):
    pass


def require(condition, reason):
    if not condition:
        raise IsolationUnproven(reason)


def endpoint(value):
    match = re.fullmatch(r"\[([^\]]+)\]:(\d+)|([^:]+):(\d+)", value)
    require(match is not None, "unsupported actual controller endpoint")
    address = ipaddress.ip_address(match.group(1) or match.group(3))
    port = int(match.group(2) or match.group(4))
    require(1 <= port <= 65535 and not address.is_unspecified and not address.is_multicast, "invalid controller socket endpoint")
    return str(address), port


def controller_flows(lsof, allowed_pids):
    require(allowed_pids and all(type(pid) is int and pid > 1 for pid in allowed_pids), "explicit live controller PIDs required")
    pid = uid = descriptor = protocol = state = name = None
    flows = []
    def finish():
        if name is None:
            return
        require(pid in allowed_pids and uid is not None and descriptor is not None and protocol == "TCP" and state == "ESTABLISHED",
                "unrecognized or non-established controller socket provenance")
        pair = name.split("->")
        require(len(pair) == 2, "controller listener/unconnected socket is not an established control channel")
        local, remote = endpoint(pair[0]), endpoint(pair[1])
        require(ipaddress.ip_address(local[0]).version == ipaddress.ip_address(remote[0]).version, "mixed IP families")
        if not ipaddress.ip_address(remote[0]).is_loopback:
            flows.append({"pid": pid, "uid": uid, "fd": descriptor, "localIP": local[0], "localPort": local[1],
                          "remoteIP": remote[0], "remotePort": remote[1]})
    for line in lsof.splitlines():
        if not line:
            continue
        key, value = line[0], line[1:]
        if key == "p":
            finish()
            pid = int(value)
            uid = descriptor = protocol = state = name = None
        elif key == "u":
            uid = int(value)
        elif key == "f":
            finish()
            descriptor = value
            protocol = state = name = None
        elif key == "P":
            protocol = value
        elif key == "T" and value.startswith("ST="):
            state = value[3:]
        elif key == "n":
            name = value
    finish()
    require(bool(flows), "no independently observed nonlocal established controller TCP channel; cannot safely enable a global deny")
    return flows


def root_anchor_supported(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    require(lines == ['anchor "com.apple/*" all'] or
            lines == ['scrub-anchor "com.apple/*" all fragment reassemble', 'anchor "com.apple/*" all'],
            "unknown root PF ordering; never rewrite or flush host/system policy")


def reject_unreviewed_tree(text, translation=False):
    for line in text.splitlines():
        line = line.strip()
        if not line or line in {"{", "}"}:
            continue
        require(re.fullmatch(r'(?:scrub-anchor|anchor|nat-anchor|rdr-anchor|dummynet-anchor) "[A-Za-z0-9_./*:-]+" all(?: fragment reassemble)?(?: \{)?', line),
                "unreviewed existing nested " + ("translation" if translation else "filter") + " rule/quick path; preserve it and refuse mutation")
    parse_pf_tree(text)


def plan_rules(run_id, flows):
    name = "zzzz_calledit_" + uuid.UUID(run_id).hex
    require(bool(flows), "independent established controller sockets required")
    rules = []
    for index, flow in enumerate(flows):
        local = ipaddress.ip_address(flow["localIP"])
        remote = ipaddress.ip_address(flow["remoteIP"])
        require(local.version == remote.version and not remote.is_loopback, "invalid control exception")
        for key in ("localPort", "remotePort"):
            require(type(flow[key]) is int and 1 <= flow[key] <= 65535, "invalid control port")
        family = "inet" if local.version == 4 else "inet6"
        rules.append(f'pass out quick {family} proto tcp from {local} port {flow["localPort"]} to {remote} port {flow["remotePort"]} flags any no state label "{name}_control_{index}_out"')
        rules.append(f'pass in quick {family} proto tcp from {remote} port {flow["remotePort"]} to {local} port {flow["localPort"]} flags any no state label "{name}_control_{index}_in"')
    rules.extend(['pass quick on lo0 inet from 127.0.0.1 to 127.0.0.1 no state',
                  'pass quick on lo0 inet6 from ::1 to ::1 no state'])
    for family, address, suffix in (("inet", "198.51.100.77", "4"), ("inet6", "2001:db8::77", "6")):
        for protocol in ("tcp", "udp"):
            rules.append(f'block drop out quick {family} proto {protocol} to {address} port 65432 label "{name}_probe_{protocol}{suffix}"')
    rules.append(f'block drop out log (all, user) quick proto udp to any port 53 label "{name}_dns"')
    rules.append(f'block drop quick all label "{name}_deny"')
    return "com.apple/" + name, "\n".join(rules) + "\n"


def require_no_unowned_states(states, flows):
    for line in states.splitlines():
        if not line.strip():
            continue
        require(" tcp " in " " + line.lower() + " " and "ESTABLISHED:ESTABLISHED" in line,
                "preexisting non-controller/UDP PF state could bypass new deny rules; never flush it")
        tokens = set(re.findall(r"(?:\[[a-fA-F0-9:]+\]|(?:\d{1,3}\.){3}\d{1,3}):\d+", line))
        def rendered(address, port):
            return ("[" + address + "]" if ":" in address else address) + ":" + str(port)
        require(any(tokens == {rendered(flow["localIP"], flow["localPort"]), rendered(flow["remoteIP"], flow["remotePort"])} for flow in flows),
                "unknown existing PF state; preserve it and block this run instead")


def plan_no_ip_rules(run_id):
    name = "zzzz_calledit_" + uuid.UUID(run_id).hex
    rules = ['pass quick on lo0 inet from 127.0.0.1 to 127.0.0.1 no state',
             'pass quick on lo0 inet6 from ::1 to ::1 no state']
    for family, address, suffix in (("inet", "198.51.100.77", "4"), ("inet6", "2001:db8::77", "6")):
        for protocol in ("tcp", "udp"):
            rules.append(f'block drop out quick {family} proto {protocol} to {address} port 65432 label "{name}_probe_{protocol}{suffix}"')
    rules.extend([f'block drop out log (all, user) quick proto udp to any port 53 label "{name}_dns"',
                  f'block drop quick all label "{name}_deny"'])
    return "com.apple/" + name, "\n".join(rules) + "\n"


def parse_pf_tree(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    index = 0
    def group(nested=False):
        nonlocal index
        result = []
        while index < len(lines):
            line = lines[index]
            index += 1
            if line == "}":
                require(nested, "unexpected recursive PF closing brace")
                return result
            header = re.fullmatch(r'((?:scrub-anchor|anchor|nat-anchor|rdr-anchor|dummynet-anchor) "([A-Za-z0-9_./*:-]+)" all(?: fragment reassemble)?)( \{)?', line)
            if header:
                children = group(True) if header.group(3) else []
                result.append(("anchor", header.group(1), header.group(2), children))
            else:
                require("{" not in line and "}" not in line, "unknown recursive PF serialization")
                result.append(("rule", line))
        require(not nested, "truncated recursive PF tree")
        return result
    return group()


def verify_owned_tree(baseline, active, anchor, rules):
    reject_unreviewed_tree(baseline)
    expected = parse_pf_tree(baseline)
    observed = parse_pf_tree(active)
    found = []
    expected_rules = [("rule", line.strip()) for line in rules.splitlines() if line.strip()]
    require(expected_rules, "canonical owned rules are missing")
    def remove(nodes, apple=False, depth=0):
        result = []
        for node in nodes:
            if node[0] != "anchor":
                result.append(node)
                continue
            _, header, name, children = node
            if name in {anchor, anchor.split("/")[-1]}:
                require(apple and header == 'anchor "' + name + '" all' and children == expected_rules and not found,
                        "only the exact canonical owned-rule insertion is permitted")
                found.append(name)
                continue
            child_scope = depth == 0 and header in {'anchor "com.apple/*" all', 'anchor "com.apple" all'}
            result.append(("anchor", header, name, remove(children, child_scope, depth + 1)))
        return result
    require(remove(observed) == expected and len(found) == 1, "unowned PF tree changed; never adopt an arbitrary active snapshot")


def verify_anchor_insertion(initial, actual, anchor):
    def names(text):
        values = [line.strip().split("/")[-1] for line in text.splitlines() if line.strip()]
        require(len(values) == len(set(values)) and all(re.fullmatch(r"[A-Za-z0-9_.:-]+", value) for value in values), "unknown anchor inventory format")
        return values
    before, after = names(initial), names(actual)
    own = anchor.split("/")[-1]
    require(own not in before and sorted(after) == sorted([*before, own]) and max(after) == own, "only the final owned anchor may have been inserted")


def denial_delta(before, after, run_id):
    name = "zzzz_calledit_" + uuid.UUID(run_id).hex + "_deny"
    def count(text):
        matches = re.findall(r'label "' + name + r'"[^\n]*\n\s*\[\s*Evaluations:.*?Packets:\s*(\d+)', text)
        require(bool(matches), "missing actual kernel deny-rule counters")
        return sum(int(value) for value in matches)
    difference = count(after) - count(before)
    require(difference > 0, "no observed kernel drop; timeout/NXDOMAIN/no-route alone is not denial proof")
    return difference
