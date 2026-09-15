import { MANAGED_DIRECTORY_PROTOCOL } from './ssh-managed-directory-protocol'

export const MANAGED_DIRECTORY_PROGRAM =
  MANAGED_DIRECTORY_PROTOCOL +
  String.raw`
def stage():
    tree=Q['tree']; files,dirs=manifest(tree)
    expected=Q['location']
    if location(ROOT,Q['entry'])!=expected: return {'status':'not-applied'}
    prerequisites(ROOT)
    parent,name,ancestors=open_parent(ROOT,Q['entry'],True,expected)
    fd=None
    try:
        root_current(ROOT)
        os.mkdir(name,0o755,dir_fd=parent)
        fd=os.open(name,DF,dir_fd=parent); os.fchmod(fd,0o755)
        for entry in sorted(dirs,key=lambda p:(p.count('/'),p)):
            if not entry: continue
            at,leaf,_=open_parent(fd,entry)
            try:
                os.mkdir(leaf,0o755,dir_fd=at)
                created=os.open(leaf,DF,dir_fd=at)
                try: os.fchmod(created,0o755)
                finally: os.close(created)
            finally: os.close(at)
        emit({'status':'ready'})
        for row in tree['files']:
            at,leaf,_=open_parent(fd,row['entry'])
            out=None
            try:
                out=os.open(leaf,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,row['mode'],dir_fd=at)
                total=0
                while True:
                    line=sys.stdin.buffer.readline(90000)
                    if not line or not line.endswith(b'\n'): raise Different()
                    if line==b'\n': break
                    chunk=base64.b64decode(line[:-1],validate=True)
                    total+=len(chunk)
                    if len(chunk)>65536 or total>row['size']: raise Different()
                    view=memoryview(chunk)
                    while view:
                        count=os.write(out,view); view=view[count:]
                if total!=row['size']: raise Different()
                os.fchmod(out,row['mode']); os.fsync(out)
            finally:
                if out is not None: os.close(out)
                os.close(at)
        os.fsync(fd)
        result=receipt(ROOT,Q['entry'],os.fstat(fd),ancestors,tree)
        if result['rootDevice']!=expected['rootDevice'] or result['rootInode']!=expected['rootInode'] or ancestors[:len(expected['ancestors'])]!=expected['ancestors']: raise Different()
        inspect(ROOT,Q['entry'],tree,result)
        return {'status':'staged','receipt':result}
    finally:
        if fd is not None: os.close(fd)
        os.close(parent)
def exact(r): return inspect(ROOT,r['entry'],r['tree'],r)
def commit():
    global SUBMITTED
    action=Q['action']; before=Q.get('before'); candidate=Q.get('candidate')
    target=Q['target'] if action=='add' else before['entry']
    source=candidate['entry'] if candidate else Q['quarantine']
    same_parent(source,target)
    bound_root(ROOT,candidate or before)
    parent,targetname,ancestors=open_parent(ROOT,target,False,candidate or before)
    try:
        if before and ancestors!=before['ancestors']: raise Different()
        prerequisites(parent)
        try: fcntl.flock(parent,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: return {'status':'not-applied'}
        if candidate: exact(candidate)
        if before: exact(before)
        sourcename=parts(source)[-1]
        root_current(ROOT)
        # This is the immediate publication boundary. The controller persists
        # intent before starting the command and does not mistake later loss for cancellation.
        SUBMITTED=True
        emit({'status':'submitting'})
        if action=='add':
            try: rename(parent,sourcename,targetname,1)
            except FileExistsError: return {'status':'not-applied'}
            published=moved(candidate,target)
            exact(published)
            return {'status':'completed','published':published}
        if action=='update':
            rename(parent,sourcename,targetname,2)
            published=moved(candidate,target); displaced=moved(before,source)
            try:
                exact(displaced); exact(published)
                return {'status':'completed','published':published,'displaced':displaced}
            except (Different,OSError):
                # Cooperating locks cannot exclude ordinary editors. Restore only
                # while the published candidate is still exact. Any competing object
                # exchanged by a last-instant race remains present, never deleted.
                try:
                    exact(published)
                    if not same(os.stat(sourcename,dir_fd=parent,follow_symlinks=False),before): raise Different()
                    rename(parent,sourcename,targetname,2)
                except (Different,OSError): pass
                return {'status':'uncertain'}
        if action=='remove':
            try: rename(parent,targetname,sourcename,1)
            except FileExistsError: return {'status':'not-applied'}
            displaced=moved(before,source)
            try:
                exact(displaced)
                try: os.stat(targetname,dir_fd=parent,follow_symlinks=False)
                except FileNotFoundError: return {'status':'completed','displaced':displaced}
            except (Different,OSError): pass
            # Never overwrite a new target while restoring a raced removal.
            try:
                if same(os.stat(sourcename,dir_fd=parent,follow_symlinks=False),before): rename(parent,sourcename,targetname,1)
            except OSError: pass
            return {'status':'uncertain'}
        raise Different()
    finally:
        os.close(parent)
def cleanup():
    global EFFECTS
    r=Q['receipt']; exact(r)
    parent,name,_=open_parent(ROOT,r['entry'],False,r)
    try: prerequisites(parent)
    except: os.close(parent); raise
    # Detach into an exclusively allocated, private operation-owned directory.
    # Workspace names are never unlinked based on an earlier inspection.
    quarantine=name+'.cleanup'; parts(quarantine)
    os.mkdir(quarantine,0o700,dir_fd=parent)
    EFFECTS=True
    private=os.open(quarantine,DF,dir_fd=parent)
    allocated=os.fstat(private)
    fd=None
    try:
        if stat.S_IMODE(allocated.st_mode)!=0o700: raise Different()
        root_current(ROOT)
        rename_to(parent,name,private,'tree',1)
        fd=os.open('tree',DF,dir_fd=private)
        try:
            if not same(os.fstat(fd),r): raise Different()
            verify_tree(fd,r['tree'])
        except (Different,OSError):
            # The detached object changed before ownership could be established.
            # Preserve it; restoration never overwrites a newly-created target.
            try: rename_to(private,'tree',parent,name,1)
            except OSError: pass
            return {'status':'retained'}
        # Destruction now uses the exclusive private directory, not a public
        # target name. A changed/unknown private entry halts the operation.
        files,dirs=manifest(r['tree'])
        for entry,row in files.items():
            at,leaf,_=open_parent(fd,entry)
            child=None
            try:
                child=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=at)
                s=os.fstat(child)
                if not stat.S_ISREG(s.st_mode) or stat.S_IMODE(s.st_mode)!=row['mode'] or file_hash(child,row['size'])!=(row['size'],row['sha256']): raise Different()
                if identity(os.stat(leaf,dir_fd=at,follow_symlinks=False))!=identity(s): raise Different()
                os.unlink(leaf,dir_fd=at)
            finally:
                if child is not None: os.close(child)
                os.close(at)
        for entry in sorted(dirs,key=lambda p:p.count('/'),reverse=True):
            if not entry: continue
            at,leaf,_=open_parent(fd,entry)
            try: os.rmdir(leaf,dir_fd=at)
            finally: os.close(at)
        if not same(os.stat('tree',dir_fd=private,follow_symlinks=False),r): raise Different()
        os.rmdir('tree',dir_fd=private)
        root_current(ROOT)
        if identity(os.stat(quarantine,dir_fd=parent,follow_symlinks=False))!=identity(allocated): raise Different()
        os.rmdir(quarantine,dir_fd=parent)
        return {'status':'cleaned'}
    finally:
        if fd is not None: os.close(fd)
        os.close(private); os.close(parent)
ROOT=None
def original_commit_state():
    # A failing syscall can still have effects (for example after an NFS retry).
    # Only exact post-error observations can prove the original bound state.
    try:
        before=Q.get('before'); candidate=Q.get('candidate')
        if candidate: exact(candidate)
        if before: exact(before)
        if Q['action']!='update':
            entry=Q['target'] if Q['action']=='add' else Q['quarantine']
            expected=candidate or before
            observed=inspection(entry,expected['tree'])
            if observed['status']!='absent': return False
            at=observed['location']
            if any(at[k]!=expected[k] for k in ('root','rootDevice','rootInode','ancestors')): return False
        return True
    except (Different,OSError,ValueError,KeyError,TypeError): return False
def inspection(entry,tree):
    observed=location(ROOT,entry)
    if observed['missingParents']: return {'status':'absent','location':observed}
    try:
        at,leaf,_=open_parent(ROOT,entry)
        try: os.stat(leaf,dir_fd=at,follow_symlinks=False)
        finally: os.close(at)
    except FileNotFoundError: return {'status':'absent','location':observed}
    try: return {'status':'exact','receipt':inspect(ROOT,entry,tree)}
    except (Different,OSError): return {'status':'different'}
try:
    header=sys.stdin.buffer.readline(1024*1024)
    if not header.endswith(b'\n'): raise Different()
    Q=json.loads(header); R=Q['root']; ROOT=open_root(R['path'])
    operation=Q['operation']
    if operation=='inspect':
        result=inspection(Q['entry'],Q['tree'])
    elif operation=='inspect-many':
        entries=Q['entries']
        if not isinstance(entries,list) or len(entries)>128 or sum(sum(f['size'] for f in e['tree']['files']) for e in entries)>256*1024*1024: raise Different()
        result={'results':[inspection(e['entry'],e['tree']) for e in entries]}
    elif operation=='stage': result=stage()
    elif operation=='commit': result=commit()
    elif operation=='cleanup': result=cleanup()
    else: raise Different()
    emit(result)
except Unavailable:
    known=not EFFECTS and (not SUBMITTED or original_commit_state())
    emit({'status':'unavailable','noEffects':True} if known else {'status':'uncertain'})
except (Different,OSError,ValueError,KeyError,TypeError): emit({'status':'refused'})
finally:
    if ROOT is not None: os.close(ROOT)
`
